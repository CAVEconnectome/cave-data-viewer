"""Emit a starter `config/datastacks/<ds>.yaml` skeleton.

Three modes (see docs/scaffolder-pattern.md):
  - Interactive (default): prompts for every value.
  - Hybrid: flags skip the corresponding prompts.
  - Non-interactive (--non-interactive): no prompts; missing required
    values error out.

Each "feature block" (cell-id lookup, synapse overrides, decoration
warmup, synapse warmup, feature explorer) has a yes/no toggle. Yes
emits the block uncommented with placeholder values to fill in; no
leaves the block commented as a template that documents what it does.

Companion to docs/setting-up-a-datastack.md.

Usage:
    # Full interactive
    uv run python scripts/scaffold_datastack.py

    # Hybrid - name from flag, prompted for the rest
    uv run python scripts/scaffold_datastack.py --datastack my_ds

    # Non-interactive - every value supplied
    uv run python scripts/scaffold_datastack.py --non-interactive \\
        --datastack my_ds --live-enabled \\
        --cell-id-lookup --decoration-warmup \\
        --no-synapse-warmup --no-synapse-overrides \\
        --no-feature-explorer
"""

from __future__ import annotations

import argparse
import sys
import textwrap
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt


_REPO_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_CONFIG_DIR = _REPO_ROOT / "config" / "datastacks"
_EXAMPLES_ROOT = _REPO_ROOT / "config" / "examples"
_RECIPES_ROOT = _REPO_ROOT / "config" / "recipes"


# ────────── Feature block templates ──────────
# Each block has two parts:
#   - prose: always emitted as comments. Documents what the block does
#     and when to use it.
#   - body: emitted uncommented when the toggle is on, commented when
#     off. Contains placeholder values the operator must replace.

_CELL_ID_PROSE = """\
# ---- cell-id lookup -----------------------------------------------------
# Cell ids (typically nucleus ids) are persistent identifiers that
# survive proofreading splits/merges; root ids are not. The forward
# direction (cell_id → current root_id) uses a materialized view; the
# reverse direction walks one or more annotation tables. Omit all three
# keys if the datastack has no cell-id concept — the SPA hides the
# cell-id input automatically.
#
# Forward direction: name a CAVE resource and its kind. CAVE distinguishes
# views from tables at the API level (the consuming code dispatches on
# `kind`).
"""

_CELL_ID_BODY = """\
cell_id_lookup:
  kind: view                                          # or "table"
  name: <CAVE VIEW OR TABLE NAME>
root_id_lookup_main_table: <CAVE TABLE NAME>
root_id_lookup_alt_tables:
  - <OPTIONAL ALTERNATE TABLE>
"""

_SYNAPSE_OVERRIDE_PROSE = """\
# ---- synapse-table override -------------------------------------------
# Override individual fields of the aligned-volume's `synapse:` config.
# Omitted fields inherit. Omit the whole block to inherit everything.
"""

_SYNAPSE_OVERRIDE_BODY = """\
synapse:
  position_prefix: <ctr_pt|anchor_pt>     # aligned-volume default is usually ctr_pt
  aggregation_rules:
    median_size:
      column: size
      agg: median
"""

_DECORATION_WARMUP_PROSE = """\
# ---- decoration warmup ------------------------------------------------
# Periodic refresh of whole-decoration-table caches at the latest valid
# mat version. Set `startup_delay_seconds` to a few minutes in
# autoscaling deployments so pod scale-up doesn't thunder into CAVE.
"""

_DECORATION_WARMUP_BODY = """\
decoration_warmup:
  enabled: true
  tables:
    - <CAVE CELL TYPE TABLE>
  warm_soma_table: true
  interval_seconds: 3600
  startup_delay_seconds: 180
"""

_SYNAPSE_WARMUP_PROSE = """\
# ---- synapse warmup ----------------------------------------------------
# Warm synapse caches for cells named by a proofreading-status table.
"""

_SYNAPSE_WARMUP_BODY = """\
synapse_warmup:
  source:
    table: <PROOFREADING STATUS TABLE>
    root_id_column: pt_root_id
    filters: {status_axon: "eq:true"}
  max_cells: 2000
  parallel_workers: 8
"""

_FEATURE_EXPLORER_PROSE = """\
# ---- feature explorer -------------------------------------------------
# Enable /explore for this datastack. The embedding catalog lives at
# <CDV_FEATURE_TABLES_BASE_URI>/feature_tables/<datastack>/ — new
# feature tables are added by dropping a (parquet, yaml) pair under that
# subdir; no datastack YAML edit and no service redeploy.
#
# `cell_id_source_table` names the CAVE table whose row ids the
# feature_tables' id_column references. Optional fallback — per-FT YAMLs
# can override.
"""

_FEATURE_EXPLORER_BODY = """\
feature_explorer:
  enabled: true
  cell_id_source_table: <CAVE TABLE NAME>
"""

_BLOCK_TOGGLES: tuple[tuple[str, str, str, str], ...] = (
    # (attr, prompt, prose, body)
    ("cell_id_lookup", "Enable cell-id lookup block?", _CELL_ID_PROSE, _CELL_ID_BODY),
    ("synapse_overrides", "Enable synapse-table override block?", _SYNAPSE_OVERRIDE_PROSE, _SYNAPSE_OVERRIDE_BODY),
    ("decoration_warmup", "Enable decoration-warmup block?", _DECORATION_WARMUP_PROSE, _DECORATION_WARMUP_BODY),
    ("synapse_warmup", "Enable synapse-warmup block?", _SYNAPSE_WARMUP_PROSE, _SYNAPSE_WARMUP_BODY),
    ("feature_explorer", "Enable feature-explorer block?", _FEATURE_EXPLORER_PROSE, _FEATURE_EXPLORER_BODY),
)


def _comment(body: str) -> str:
    """Prefix every line with '# '; blank lines become '#'."""
    return "\n".join("#" if not line.strip() else "# " + line for line in body.splitlines()) + "\n"


def _block(prose: str, body: str, enabled: bool) -> str:
    return prose + (body if enabled else _comment(body))


# ────────── Rendering ──────────


def _render_yaml(
    datastack: str,
    aligned_volume: str | None,
    live_enabled: bool,
    toggles: dict[str, bool],
) -> str:
    """Render the skeleton YAML body.

    `toggles` keys match the attrs in `_BLOCK_TOGGLES`; values determine
    whether each block is rendered uncommented (True) or commented (False).
    """
    av_note = (
        f"# Aligned volume: `{aligned_volume}`. Spatial transform + synapse-table\n"
        f"# defaults come from `config/aligned_volumes/{aligned_volume}.yaml`.\n"
        if aligned_volume
        else "# Spatial transform + synapse defaults are inherited from the\n"
        "# datastack's aligned_volume YAML (see config/aligned_volumes/).\n"
    )

    live_mode_block = (
        "# true = the SPA exposes \"live\" mode (latest CAVE state). Internal\n"
        "# / pre-release datastacks usually want this; public/release datastacks\n"
        "# should set false so users don't see unstable data.\n"
        "live_mode: true\n"
        if live_enabled
        else "# false = only published mat versions are exposed; live mode is hidden.\n"
        "# Public/release datastacks should leave this false.\n"
        "live_mode: false\n"
    )

    header = (
        f"# Datastack: {datastack}\n"
        f"#\n"
        f"{av_note}"
        f"#\n"
        f"# Reference: docs/setting-up-a-datastack.md (Section 1)\n"
        f"# Schema:    cave_data_viewer/api/services/datastack_config.py::DatastackConfig\n"
        f"\n"
    )

    cache_alias = (
        "# Cache namespace alias. Use when this datastack describes the same\n"
        "# underlying data as another datastack (e.g. a public release of an\n"
        "# internal volume). Cache reads/writes redirect to the alias target;\n"
        "# CAVE calls still use *this* datastack name.\n"
        "#\n"
        "# cache_alias: minnie65_phase3_v1\n"
        "\n"
    )

    lts_footer = (
        f"# ---- LTS marker (NOT in this file) ------------------------------------\n"
        f"# Examples are filtered against `<ds>-longlived-versions.json` in the\n"
        f"# GCS cache bucket:\n"
        f"#     gs://<CDV_GCS_CACHE_BUCKET>/<CDV_GCS_CACHE_PREFIX>info/{datastack}-longlived-versions.json\n"
        f"# Minimal shape:\n"
        f"#     {{\"longlived_versions\": [<mv-int>, ...]}}\n"
        f"# Without this file, all examples for this datastack are hidden behind\n"
        f"# the \"no LTS published\" empty state.\n"
    )

    parts = [header, live_mode_block, "\n", cache_alias]
    for attr, _prompt, prose, body in _BLOCK_TOGGLES:
        parts.append(_block(prose, body, toggles[attr]))
        parts.append("\n")
    parts.append(lts_footer)
    return "".join(parts)


# ────────── Interactive resolution ──────────


def _resolve_values(args: argparse.Namespace, console: Console) -> None:
    """Fill in unset args via prompts (interactive) or defaults/errors
    (non-interactive). Mutates `args` in place.

    The resolver is the single point that bridges the three modes: it
    reads `args.<attr>` first and falls back to a prompt only when
    interactive is on. `--non-interactive` errors out for the naming arg
    and applies defaults for everything else.
    """
    interactive = not args.non_interactive

    if interactive:
        console.print(
            Panel(
                "Scaffolding a new datastack config.\n"
                "Press Enter to accept defaults. Pass --non-interactive to skip prompts.",
                title="scaffold_datastack",
                border_style="cyan",
            )
        )

    # Naming arg — required; no sensible default.
    if args.datastack is None:
        if not interactive:
            console.print("[red]--non-interactive: --datastack is required[/]")
            raise SystemExit(2)
        args.datastack = Prompt.ask("Datastack name", console=console).strip()
        if not args.datastack:
            console.print("[red]datastack name cannot be empty[/]")
            raise SystemExit(2)

    # Aligned volume — informational; default empty.
    if args.aligned_volume is None and interactive:
        av = Prompt.ask(
            "Aligned-volume name (informational; blank to skip)",
            default="",
            console=console,
        ).strip()
        args.aligned_volume = av or None

    # Live mode toggle. None means "not specified by flag"; default off
    # so public/release behavior is the baseline.
    if args.live_enabled is None:
        if interactive:
            args.live_enabled = Confirm.ask(
                "Enable live mode? (latest CAVE state; usually off for public/release)",
                default=False,
                console=console,
            )
        else:
            args.live_enabled = False

    # Block toggles. None means "not specified by flag"; default off.
    for attr, prompt, _prose, _body in _BLOCK_TOGGLES:
        if getattr(args, attr) is None:
            if interactive:
                setattr(args, attr, Confirm.ask(prompt, default=False, console=console))
            else:
                setattr(args, attr, False)


# ────────── Main ──────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=textwrap.dedent(__doc__ or "").strip(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--datastack", default=None, help="datastack name (used as filename)")
    parser.add_argument(
        "--aligned-volume",
        default=None,
        help="aligned_volume name (informational; used in a generated comment)",
    )

    parser.add_argument(
        "--live-enabled",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="expose live mode (latest CAVE state). Default off (public/release behavior).",
    )

    # Block toggles. `BooleanOptionalAction` provides `--foo` / `--no-foo`
    # with default=None so "not specified" is distinguishable from
    # "explicitly off" — interactive mode prompts only the unspecified
    # ones.
    for attr, _prompt, _prose, _body in _BLOCK_TOGGLES:
        flag = "--" + attr.replace("_", "-")
        parser.add_argument(
            flag,
            action=argparse.BooleanOptionalAction,
            default=None,
            help=f"emit {attr} block uncommented (default: commented)",
        )

    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output path (default: config/datastacks/<datastack>.yaml)",
    )
    parser.add_argument("--force", action="store_true", help="overwrite existing file")
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="skip prompts; missing required values error out",
    )
    args = parser.parse_args(argv)

    console = Console()
    _resolve_values(args, console)

    toggles = {attr: getattr(args, attr) for attr, _p, _pr, _b in _BLOCK_TOGGLES}

    out_path = args.out or (_DEFAULT_CONFIG_DIR / f"{args.datastack}.yaml")
    if out_path.exists() and not args.force:
        console.print(f"[red]refusing to overwrite existing file:[/] {out_path}")
        console.print("(pass --force to overwrite, or --out <path> to write elsewhere)")
        return 2

    rendered = _render_yaml(args.datastack, args.aligned_volume, args.live_enabled, toggles)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(rendered)

    # Pre-create the convention-path subdirs the recipe registry reads
    # from (`config/{examples,recipes}/<ds>/`). The registry tolerates
    # missing dirs, but seeding them means an operator can drop a YAML in
    # without `mkdir -p` and `ls` shows the expected layout.
    examples_dir = _EXAMPLES_ROOT / args.datastack
    recipes_dir = _RECIPES_ROOT / args.datastack
    examples_dir.mkdir(parents=True, exist_ok=True)
    recipes_dir.mkdir(parents=True, exist_ok=True)

    console.print(f"[green]wrote[/] {out_path}")
    console.print(f"[green]created[/] {examples_dir}/")
    console.print(f"[green]created[/] {recipes_dir}/")
    console.print()
    console.print("[bold]Next:[/]")
    console.print(f"  1. Edit {out_path} — replace <PLACEHOLDER> values in enabled blocks.")
    next_step = 2
    if toggles["feature_explorer"]:
        console.print(f"  {next_step}. Author a per-FT YAML for the feature explorer:")
        console.print(
            f"       uv run python scripts/scaffold_feature_explorer.py "
            f"--parquet <path> --datastack {args.datastack}"
        )
        next_step += 1
    console.print(
        f"  {next_step}. Drop operator examples in {examples_dir}/<id>.yaml and "
        f"recipes in {recipes_dir}/<id>.yaml (see docs/setting-up-a-datastack.md §3–§4)."
    )
    next_step += 1
    console.print(f"  {next_step}. Restart the backend; the new datastack appears in /datastacks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
