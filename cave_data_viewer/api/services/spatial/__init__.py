"""SpatialProvider registry.

Built-in providers (`cortex`, `null`) live in this package; out-of-tree
providers register themselves at import time via `register_provider(...)`,
loaded by setting `spatial.provider_module` in the aligned-volume YAML.

`build_spatial_provider(spatial_cfg)` is the single entry point — endpoints
call it once per request and pass the result down the connectivity / plot
pipelines. Returns a `NullSpatialProvider` when no spatial frame is configured,
so callers never need to None-check the provider itself.
"""

from __future__ import annotations

import importlib

from .cache import CachedSpatialFeatures, compute_spatial_features_cached
from .cortex import CortexSpatialProvider
from .null_provider import NullSpatialProvider
from .protocol import FeatureSpec, SpatialProvider, SummaryPanel


_PROVIDERS: dict[str, type[SpatialProvider]] = {
    "cortex": CortexSpatialProvider,
    "null": NullSpatialProvider,
}


def register_provider(name: str, cls: type[SpatialProvider]) -> None:
    """Register a SpatialProvider implementation under `name`.

    Out-of-tree anatomies call this at module import; the YAML config triggers
    the import via `spatial.provider_module`. Re-registering a name is allowed
    (overrides the previous entry) so a deployment can shadow a built-in
    provider with a local variant when needed.
    """
    _PROVIDERS[name] = cls


def build_spatial_provider(spatial_cfg) -> SpatialProvider:
    """Construct the provider for a given aligned-volume `SpatialConfig`.

    Resolution order:
      1. If `provider_module` is set, import it (gives the module a chance
         to call `register_provider` at top level).
      2. Pick the explicit `provider` name when given, else infer from the
         params: `"cortex"` if `transform` is present, else `"null"`.
      3. Look up the class in the registry and instantiate it with `params`.

    Unknown provider names fall back to `null` rather than raising — same
    null-graceful pattern as the rest of the codebase. A misspelled name in
    YAML is visible as "no spatial features" rather than a 500 at request
    time, and the operator notices when the SPA doesn't show depth columns.
    """
    if spatial_cfg.provider_module:
        importlib.import_module(spatial_cfg.provider_module)

    name = spatial_cfg.provider
    if not name:
        name = "cortex" if (spatial_cfg.params or {}).get("transform") else "null"

    cls = _PROVIDERS.get(name) or _PROVIDERS["null"]
    return cls(spatial_cfg.params or {})


__all__ = [
    "CachedSpatialFeatures",
    "FeatureSpec",
    "SpatialProvider",
    "SummaryPanel",
    "build_spatial_provider",
    "compute_spatial_features_cached",
    "register_provider",
]
