"""Pre-populate the L2 cache (synapse DataFrames + decoration tables)
for proofread cells in a target materialization.

Two operations, run in sequence on a release day:

  1. **Mark** a version as long-lived by writing/updating the marker
     file at ``gs://<bucket>/<prefix>info/<datastack>-longlived-versions.json``.
     The running service polls this file with TTL caching and routes
     L2 reads/writes to the ``cache/longlived/`` partition for marked
     versions.

  2. **Warm** the L2 cache by fetching synapse data for every cell in
     the configured proofread set. Uses the already-shipping
     ``NeuronQuery._synapse_df`` write path — the L2 fan-out happens
     automatically as a side effect of fetching.

Run this once per public release. Reuses the bucket / prefix /
project / auth env that the service uses.

Why a script (not in-service):
  - Service runs on spot instances; a 25-min warm pass interrupted
    mid-flight produces a partial state. A dedicated process on a
    stable host completes the pass predictably.
  - Quarterly cadence aligns with operator workflow, not the service's
    continuous heartbeat.

Required env:
  CDV_GCS_CACHE_BUCKET, CDV_GCS_CACHE_PREFIX, CDV_GCS_CACHE_PROJECT,
  CDV_WARMUP_AUTH_TOKEN, plus ADC for GCS access.

Example:
  uv run cdv-warm-cache \\
      --datastack minnie65_public \\
      --mat-version 1764 \\
      --expires 2028-01-15
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


logger = logging.getLogger("cdv.warm_cache")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--datastack", required=True, help="Datastack name, e.g. minnie65_public.")
    parser.add_argument("--mat-version", required=True, type=int, help="Materialization version to warm.")
    # Mark vs warm are independent toggles. Default: mark + warm.
    parser.add_argument(
        "--mark-longlived",
        dest="mark_longlived",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Update the marker file to add this version to the longlived set. Default: yes.",
    )
    parser.add_argument(
        "--no-warm",
        dest="warm",
        action="store_false",
        default=True,
        help="Mark only; skip the warming pass.",
    )
    parser.add_argument("--expires", default=None, help="Informational expiration date (YYYY-MM-DD) recorded in the marker file.")
    parser.add_argument("--max-cells", type=int, default=None, help="Cap on cells to warm. Default: from datastack YAML or 2000.")
    parser.add_argument("--workers", type=int, default=None, help="Parallel CAVE workers. Default: from datastack YAML or 8.")
    parser.add_argument("--root-ids-file", default=None, help="Path to a line-separated list of root IDs. Overrides YAML source resolution.")
    parser.add_argument("--dry-run", action="store_true", help="Print the resolved cell list and exit; don't fetch anything.")
    parser.add_argument("--force", action="store_true", help="Warm even if the version isn't marked longlived (writes land under cache/default/ and get swept after 2 days).")
    return parser.parse_args(argv)


@dataclass
class WarmResults:
    cells_warmed: int = 0
    cells_failed: int = 0
    elapsed_s: float = 0.0
    failures: list[tuple[int, str]] = field(default_factory=list)  # (root_id, error_message)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args = _parse_args(argv)

    # Bypass datastack allowlist so the script can run against any
    # configured ds without a deploy-config tweak.
    os.environ.setdefault("CDV_DATASTACKS_ALLOWED", args.datastack)

    # Local imports — flask/cdv pull a lot of transitive deps that aren't
    # needed for `--help`.
    from cave_data_viewer.api import create_app
    from cave_data_viewer.api.cave import make_client_anonymous
    from cave_data_viewer.api.services.cache_lifecycle import (
        cache_datastack,
        retention_class_for,
    )
    from cave_data_viewer.api.services.datastack_config import (
        load_datastack_config,
        synapse_config_for,
    )

    app = create_app()
    with app.app_context():
        # Log the cache-namespace alias resolution prominently — operators
        # who set up `cache_alias` need to see what's actually being
        # written, not what they typed at the CLI.
        cache_ds = cache_datastack(args.datastack)
        if cache_ds != args.datastack:
            print(
                f"[note] {args.datastack} is aliased to {cache_ds}; "
                "marker file + cache writes will land under that namespace.",
                file=sys.stderr,
            )

        if args.mark_longlived:
            _update_marker_file(app, args, cache_ds)

        if not args.warm:
            print("[done] mark only — skipping warming pass.")
            return 0

        # Force a registry refresh so the script's own retention check
        # below sees the marker file we just wrote (without waiting for
        # TTL).
        registry = app.extensions.get("dcv_longlived_registry")
        if registry is not None:
            registry.invalidate(cache_ds)

        retention = (
            retention_class_for(registry, args.datastack, args.mat_version)
            if registry is not None
            else "default"
        )
        if retention != "longlived" and not args.force:
            print(
                f"ERROR: v{args.mat_version} is not marked longlived for "
                f"{args.datastack!r} (cache namespace {cache_ds!r}). "
                "Pass --mark-longlived (default) to mark it first, or "
                "--force to warm into the default-class partition (will "
                "be swept after 2 days). Refusing to silently waste a "
                "long-running warm pass.",
                file=sys.stderr,
            )
            return 2

        # Build the warming client. Anonymous auth pattern — same as the
        # in-service PeriodicWarmer. CDV_WARMUP_AUTH_TOKEN env var holds
        # the operator's CAVE token so warmer activity is audit-trailed.
        try:
            client = make_client_anonymous(
                args.datastack,
                app.config["GLOBAL_SERVER_ADDRESS"],
                materialize_version=args.mat_version,
                reason="dcv_warm_cache_script",
                env_token_var="CDV_WARMUP_AUTH_TOKEN",
            )
        except Exception as exc:
            print(f"ERROR: failed to construct CAVE client: {exc}", file=sys.stderr)
            return 3

        ds_cfg = load_datastack_config(args.datastack)
        try:
            cell_ids = _resolve_cell_list(args, client, ds_cfg)
        except Exception as exc:
            print(f"ERROR: failed to resolve cell list: {exc}", file=sys.stderr)
            return 4

        if args.dry_run:
            for rid in cell_ids:
                print(rid)
            print(f"[dry-run] {len(cell_ids)} cells would be warmed.", file=sys.stderr)
            return 0

        print(f"[warm] retention_class={retention} cells={len(cell_ids)} workers={args.workers or ds_cfg.synapse_warmup.parallel_workers if ds_cfg.synapse_warmup else 8}")
        results = _warm_cells(cell_ids, args, client, ds_cfg, app)
        _drain_l2_writer(app)
        _report(results, retention, cache_ds)
    return 0 if results.cells_failed == 0 else 1


# --- Marker-file management ---------------------------------------------------

def _update_marker_file(app, args: argparse.Namespace, cache_ds: str) -> None:
    """Idempotent merge: read existing marker (if any), upsert the
    target version (preserving other entries), write back. The file
    lives at `cache/info/<cache_ds>-longlived-versions.json` so the
    bucket-side lifecycle rules don't sweep it (they scope to
    `cache/default/` and `cache/longlived/`)."""
    from cave_data_viewer.api.services.object_store import build_info_store

    info_store = build_info_store(app)
    if info_store is None:
        print("ERROR: GCS_CACHE_BUCKET unset — can't write marker file.", file=sys.stderr)
        sys.exit(5)

    filename = f"{cache_ds}-longlived-versions.json"
    existing = info_store.get_json(filename)
    if not isinstance(existing, dict):
        existing = {"datastack": cache_ds, "longlived_versions": []}
    versions = [v for v in existing.get("longlived_versions", [])
                if isinstance(v, dict) and v.get("version") != args.mat_version]
    new_entry: dict[str, Any] = {
        "version": args.mat_version,
        "marked_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if args.expires:
        new_entry["expires_at"] = args.expires
    versions.append(new_entry)
    versions.sort(key=lambda v: v.get("version", 0))
    existing["datastack"] = cache_ds
    existing["longlived_versions"] = versions
    info_store.set_json(filename, existing)
    print(f"[mark] datastack={cache_ds} version={args.mat_version}"
          + (f" expires_at={args.expires}" if args.expires else ""))


# --- Cell-list resolution -----------------------------------------------------

def _resolve_cell_list(args: argparse.Namespace, client, ds_cfg) -> list[int]:
    """Resolve the list of root_ids to warm.

    Priority:
      1. `--root-ids-file` (explicit list, highest priority)
      2. Per-datastack `synapse_warmup.source` (CAVE table query)

    Caps the result at `--max-cells` (or the YAML default).
    """
    if args.root_ids_file:
        path = Path(args.root_ids_file)
        cell_ids = [int(line.strip()) for line in path.read_text().splitlines() if line.strip()]
    else:
        if not ds_cfg.synapse_warmup or not ds_cfg.synapse_warmup.source:
            raise ValueError(
                "no `synapse_warmup.source` block in per-datastack YAML and no "
                "--root-ids-file passed. Add one or the other."
            )
        src = ds_cfg.synapse_warmup.source
        # Resolve via tables manager — handles both tables and views.
        # The warming script always runs in materialized mode against a
        # specific version, so the tables[name] indexer is the right path.
        qf = client.materialize.tables[src.table](**src.filters)
        df = qf.query(select_columns=[src.root_id_column])
        cell_ids = sorted({int(v) for v in df[src.root_id_column].tolist() if v})

    cap = args.max_cells
    if cap is None and ds_cfg.synapse_warmup is not None:
        cap = ds_cfg.synapse_warmup.max_cells
    if cap is None:
        cap = 2000
    if len(cell_ids) > cap:
        logger.info("capping cell list from %d to %d (--max-cells)", len(cell_ids), cap)
        cell_ids = cell_ids[:cap]
    return cell_ids


# --- Warming pass -------------------------------------------------------------

def _warm_cells(cell_ids: list[int], args: argparse.Namespace,
                client, ds_cfg, app) -> WarmResults:
    """Fetch synapse df for both directions of each cell. The L2 write
    happens as a side effect of `_synapse_df` via the existing wiring."""
    from cave_data_viewer.api.services.datastack_config import synapse_config_for
    from cave_data_viewer.api.services.neuron import NeuronQuery

    syn_cfg = synapse_config_for(args.datastack, client)
    workers = args.workers
    if workers is None and ds_cfg.synapse_warmup is not None:
        workers = ds_cfg.synapse_warmup.parallel_workers
    if workers is None:
        workers = 8

    results = WarmResults()
    started = time.time()

    def _warm_one(rid: int) -> tuple[int, Exception | None]:
        try:
            nq = NeuronQuery(
                client,
                root_id=rid,
                datastack=args.datastack,
                mat_version=args.mat_version,
                synapse_aggregation_rules=syn_cfg.aggregation_rules_for_neuron_query(),
                synapse_columns=syn_cfg.merged_columns(),
                synapse_position_prefix=syn_cfg.position_prefix,
            )
            # Each direction triggers an L2 write via the existing
            # `_publish_synapse_l2` fire-and-forget path.
            nq._synapse_df("post")
            nq._synapse_df("pre")
            return rid, None
        except Exception as exc:
            return rid, exc

    # The Flask app context isn't automatically threaded — workers need
    # the context to access `current_app.extensions` (synapse L2 store +
    # writer executor). Push the context per-thread.
    def _thread_worker(rid: int) -> tuple[int, Exception | None]:
        with app.app_context():
            return _warm_one(rid)

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="cdv-warm") as pool:
        for rid, exc in pool.map(_thread_worker, cell_ids):
            if exc is None:
                results.cells_warmed += 1
            else:
                results.cells_failed += 1
                results.failures.append((rid, f"{type(exc).__name__}: {exc}"))
                logger.warning("warm failed: rid=%d %s: %s", rid, type(exc).__name__, exc)

    results.elapsed_s = time.time() - started
    return results


# --- Drain & report -----------------------------------------------------------

def _drain_l2_writer(app) -> None:
    """Block on the synapse L2 writer's pending uploads. Without this,
    fire-and-forget writes still in flight when `main()` returns get
    abandoned when the executor is GC'd."""
    writer = app.extensions.get("dcv_l2_writer")
    if writer is None:
        return
    print("[drain] waiting for L2 writer to flush…")
    writer.shutdown(wait=True)


def _report(results: WarmResults, retention_class: str, cache_ds: str) -> None:
    elapsed = _format_elapsed(results.elapsed_s)
    print(
        f"[done] cache_namespace={cache_ds} retention_class={retention_class} "
        f"cells_warmed={results.cells_warmed} cells_failed={results.cells_failed} "
        f"elapsed={elapsed}"
    )
    if results.failures:
        print(f"[failures] first {min(10, len(results.failures))}:")
        for rid, msg in results.failures[:10]:
            print(f"  rid={rid}: {msg}")


def _format_elapsed(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    if seconds < 3600:
        return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"
    return f"{int(seconds // 3600)}h{int((seconds % 3600) // 60):02d}m"


if __name__ == "__main__":
    raise SystemExit(main())
