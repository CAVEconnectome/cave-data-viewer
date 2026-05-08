"""Per-user recipe storage backed by GCS.

Personal recipes are tiny YAML documents (decoration_tables, plots, cell
filter, hide/show/coll arrays) saved per (user, datastack, recipe_id). The
on-disk format mirrors operator recipes in `config/datastacks/<ds>.yaml`'s
`recipes:` section exactly — same schema, same parser, exportable to
operator config without transformation.

The store is the single writer to its prefix, so we don't validate body
shape against a schema. `yaml.safe_load` is the only line that matters
for code-execution safety. Bounds checks (size, count, field length)
defend against DoS / quota abuse, not malformed input.

Object layout: `<CDV_GCS_CACHE_PREFIX>userdata/<user_id>/<ds>/<id>.yaml`.
One file per recipe so two-tab saves don't race and DELETE is a single
GCS call. The prefix lives outside the bucket's lifecycle-rule scope (see
scripts/setup_local_cache_bucket.sh) so user data is never aged out.

Versioning contract
-------------------
Two independent versioning axes:

- **Endpoint contract version** (URL `/api/v1/...`) — methods, status
  codes, content types. Bump only on breaking endpoint shape changes
  (e.g., splitting recipes into multiple resource types).
- **Body schema version** (the top-level `version` field on each recipe)
  — which fields exist and what they mean. This is where almost all
  evolution happens.

The body `version` is load-bearing on read. Server reads any version in
`SUPPORTED_SCHEMA_VERSIONS`; rejects unknown with 400. Server writes back
the version the client SENT (not always `CURRENT_SCHEMA_VERSION`) so a
newer client can write a newer schema through an older endpoint as long
as the server understands it. PUTs that omit `version` default to
`CURRENT_SCHEMA_VERSION` for back-compat with hand-pasted YAML.

Migration model is **lazy on read**: when v2 lands, server reads v1 →
in-memory upgrade → returns; rewrites to v2 only on next PUT. No bucket
crawl, no batch migration, costs scale with active use. The trade-off is
that long-dormant recipes stay in their original schema forever — for our
volume (kilobytes per user, dozens of users) that's fine; revisit if we
ever need a schema deprecation deadline.

Forward-compat hatch: `_KNOWN_FIELDS` is the allowlist of fields that
survive a PUT. Adding a field name here BEFORE we use it ("reserve") lets
a future client introduce the field without an older server stripping it
silently.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from .object_store import GcsObjectStore

logger = logging.getLogger("cdv.recipes")

# URL-path safety: bound the recipe-id shape so it can't escape the
# user/ds prefix or blow the filename length. The `personal-` prefix
# matches the SPA's `newPersonalId()` convention; rejecting anything else
# keeps the user's namespace from colliding with operator-recipe ids.
_RECIPE_ID_PATTERN = re.compile(r"^personal-[a-z0-9-]{4,64}$")

# Per-user-per-datastack count cap. A recipe is a few KB, so 100 is
# generous (well past any plausible real-user count) and bounds list-call
# latency + GCS object proliferation.
MAX_RECIPES_PER_DS = 100

# Body schema version the server prefers to write when the client doesn't
# specify one. Surfaced via /me/recipes/config so the SPA can negotiate.
CURRENT_SCHEMA_VERSION = 1

# Set of body schema versions the server can read AND write. A PUT with a
# `version` outside this set is rejected with 400. When v2 lands, add 2 to
# this set BEFORE clients start sending it; remove a version only after
# we're confident no recipes of that vintage remain (or after a documented
# deprecation window).
SUPPORTED_SCHEMA_VERSIONS: frozenset[int] = frozenset({1})

# Field-length sanity caps (defense in depth — not schema validation).
# These bound the on-disk shape regardless of what the SPA sends.
_FIELD_LIMITS: dict[str, int | tuple[int, int]] = {
    # Scalar string fields: max length.
    "title": 200,
    "description": 10_000,
    "cells": 1_000,
    # List fields: (max_entries, max_per_entry_length). per-entry check
    # only applies when the entry is a string.
    "decoration_tables": (50, 200),
    "plots": (50, 0),  # 0 = don't check entry shape (plots are dicts)
    "hide": (200, 200),
    "show": (200, 200),
    "coll": (200, 200),
}


class RecipeValidationError(ValueError):
    """Raised on bounds violation. Endpoint maps to 400."""


class TooManyRecipesError(Exception):
    """Raised when a NEW PUT would exceed MAX_RECIPES_PER_DS. Endpoint
    maps to 413."""


def assert_real_user(user_id: int | None) -> int:
    """Reject the anonymous (id == 0) and missing-user cases. Returns the
    user_id on success so callers can chain. Endpoint catches `ValueError`
    and returns 401 — keeping the check here means a future caller (CLI,
    batch script) can't bypass it."""
    if user_id is None:
        raise ValueError("no authenticated user")
    if user_id == 0:
        raise ValueError("anonymous user")
    return user_id


def assert_recipe_id(recipe_id: str) -> str:
    """Validate the URL-path component. This is path safety (no `..`, no
    slashes, bounded length), not body validation."""
    if not _RECIPE_ID_PATTERN.match(recipe_id):
        raise RecipeValidationError(
            f"invalid recipe id (must match {_RECIPE_ID_PATTERN.pattern})"
        )
    return recipe_id


def _object_path(user_id: int, ds: str, recipe_id: str) -> str:
    """Quote each segment so a future ds-name with `/` (unlikely but) or
    a non-ASCII char doesn't break the prefix. recipe_id is already
    regex-validated; quoting is defensive."""
    return (
        f"{quote(str(user_id), safe='')}/"
        f"{quote(ds, safe='')}/"
        f"{quote(recipe_id, safe='')}.yaml"
    )


def _ds_prefix(user_id: int, ds: str) -> str:
    return f"{quote(str(user_id), safe='')}/{quote(ds, safe='')}/"


def list_recipes(store: GcsObjectStore, user_id: int, ds: str) -> list[dict]:
    """Return every recipe the user has under `ds`. No filtering — we own
    the prefix, so anything there is ours. Returns [] on GCS error
    (matches the store's silent-failure pattern)."""
    items = store.list_yaml(_ds_prefix(user_id, ds))
    # Drop anything that didn't parse as a dict (defensive against a
    # future bug that wrote a non-dict; impossible today via put_recipe).
    return [r for r in items if isinstance(r, dict)]


def get_recipe(
    store: GcsObjectStore, user_id: int, ds: str, recipe_id: str
) -> dict | None:
    assert_recipe_id(recipe_id)
    parsed = store.get_yaml(_object_path(user_id, ds, recipe_id))
    if parsed is None:
        return None
    if not isinstance(parsed, dict):
        # Same defensive drop as list_recipes — shouldn't happen under
        # normal writes.
        return None
    return parsed


def put_recipe(
    store: GcsObjectStore,
    user_id: int,
    ds: str,
    recipe_id: str,
    recipe_dict: dict,
    *,
    enforce_count_cap: bool = True,
) -> dict:
    """Validate, stamp metadata, write. Returns the stored dict (same
    shape that GET would return). `enforce_count_cap=False` is for
    internal flows that overwrite an existing object without growing the
    user's count (the endpoint enforces the cap explicitly when needed).
    """
    assert_recipe_id(recipe_id)
    if not isinstance(recipe_dict, dict):
        raise RecipeValidationError("recipe body must be a YAML mapping")

    # Validate the body schema version BEFORE projection so the client
    # gets a clear error rather than a silent strip-and-default. Default
    # to CURRENT when absent (back-compat with hand-pasted YAML); reject
    # anything outside SUPPORTED with 400.
    requested_version = _resolve_schema_version(recipe_dict.get("version"))

    # Strip unknown keys before storage — forward-compat hatch and bounds
    # the on-disk shape so a future field-name change can't accumulate
    # cruft.
    stored = _project_known_fields(recipe_dict)

    # Bounds checks against the projected dict.
    _enforce_field_limits(stored)

    # Server-stamped metadata. URL-path id wins over body — the URL is
    # the canonical id and the body can't lie. We write back the
    # client-requested version (not always CURRENT) so a newer client
    # writing newer schema through an older endpoint doesn't get
    # downgraded by the server.
    stored["version"] = requested_version
    stored["id"] = recipe_id
    stored["saved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Reorder so the on-disk YAML leads with version/id/title/description
    # — matches operator-recipe convention and reads better in `gsutil cat`.
    stored = _ordered_for_disk(stored)

    if enforce_count_cap:
        _enforce_count_cap(store, user_id, ds, recipe_id)

    store.set_yaml(_object_path(user_id, ds, recipe_id), stored)
    return stored


def delete_recipe(
    store: GcsObjectStore, user_id: int, ds: str, recipe_id: str
) -> None:
    """Idempotent — silent on missing object."""
    assert_recipe_id(recipe_id)
    store.delete(_object_path(user_id, ds, recipe_id))


# ---------- internals ----------------------------------------------------

# Allowlist of fields that survive a PUT. Mirrors the operator-recipe
# `TourBase` fields plus the server-stamped metadata. Anything else is
# silently dropped.
#
# Reserved (not yet used by any code path, but listed here so a future
# client introducing the field doesn't have it stripped by today's server):
#   - `kind`: future personal/team/shared distinction
#   - `tags`: future organization / search labels
#
# Reserving a field name is cheap and forward-compatible. Removing a name
# from this list is a breaking change — old recipes stay on disk with the
# field, but new PUTs would lose it.
_KNOWN_FIELDS: tuple[str, ...] = (
    "version",
    "id",
    "kind",
    "tags",
    "title",
    "description",
    "decoration_tables",
    "plots",
    "cells",
    "hide",
    "show",
    "coll",
    "saved_at",
)

# Order the on-disk YAML uses. set_yaml preserves insertion order
# (sort_keys=False) so this is what `gsutil cat` shows.
_DISK_ORDER: tuple[str, ...] = (
    "version",
    "id",
    "kind",
    "title",
    "description",
    "tags",
    "saved_at",
    "decoration_tables",
    "cells",
    "hide",
    "show",
    "coll",
    "plots",
)


def _resolve_schema_version(value: object) -> int:
    """Return the validated body-schema version for a PUT.

    Absent → CURRENT_SCHEMA_VERSION (back-compat).
    Present and in SUPPORTED_SCHEMA_VERSIONS → that integer.
    Anything else → RecipeValidationError → 400.
    """
    if value is None:
        return CURRENT_SCHEMA_VERSION
    if not isinstance(value, int) or isinstance(value, bool):
        raise RecipeValidationError(
            f"version: must be an integer (got {type(value).__name__})"
        )
    if value not in SUPPORTED_SCHEMA_VERSIONS:
        supported = sorted(SUPPORTED_SCHEMA_VERSIONS)
        raise RecipeValidationError(
            f"version: unsupported schema version {value} "
            f"(server supports {supported})"
        )
    return value


def _project_known_fields(d: dict) -> dict:
    return {k: v for k, v in d.items() if k in _KNOWN_FIELDS}


def _ordered_for_disk(d: dict) -> dict:
    out: dict[str, Any] = {}
    for k in _DISK_ORDER:
        if k in d:
            out[k] = d[k]
    # Future keys not in _DISK_ORDER (none today, but safe) trail.
    for k, v in d.items():
        if k not in out:
            out[k] = v
    return out


def _enforce_field_limits(d: dict) -> None:
    for field, limit in _FIELD_LIMITS.items():
        value = d.get(field)
        if value is None:
            continue
        if isinstance(limit, int):
            # Scalar string field.
            if not isinstance(value, str):
                raise RecipeValidationError(f"{field}: must be a string")
            if len(value) > limit:
                raise RecipeValidationError(
                    f"{field}: too long ({len(value)} > {limit})"
                )
        else:
            max_entries, max_per_entry = limit
            if not isinstance(value, list):
                raise RecipeValidationError(f"{field}: must be a list")
            if len(value) > max_entries:
                raise RecipeValidationError(
                    f"{field}: too many entries ({len(value)} > {max_entries})"
                )
            if max_per_entry > 0:
                for entry in value:
                    if isinstance(entry, str) and len(entry) > max_per_entry:
                        raise RecipeValidationError(
                            f"{field}: entry too long "
                            f"({len(entry)} > {max_per_entry})"
                        )


def _enforce_count_cap(
    store: GcsObjectStore, user_id: int, ds: str, recipe_id: str
) -> None:
    """If this PUT would create a NEW recipe (id not already present) and
    the user is at the cap, refuse. An overwrite of an existing id never
    grows the count and is always allowed."""
    existing = list_recipes(store, user_id, ds)
    if any(r.get("id") == recipe_id for r in existing):
        return  # overwrite — count doesn't grow
    if len(existing) >= MAX_RECIPES_PER_DS:
        raise TooManyRecipesError(
            f"recipe count cap reached ({MAX_RECIPES_PER_DS} per datastack)"
        )
