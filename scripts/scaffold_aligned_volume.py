"""Scaffold a `config/aligned_volumes/<name>.yaml` skeleton.

Three modes (see docs/scaffolder-pattern.md):
  - Interactive (default): prompts for the name and the spatial-block toggle.
  - Hybrid: flags skip the corresponding prompts.
  - Non-interactive (--non-interactive): no prompts; missing required
    values error out.

Spatial-transform parameters (transform name, depth_range,
layer_boundaries, layer_names) are domain knowledge — the scaffolder
does NOT prompt for them. When the spatial toggle is on, the block is
emitted with the chosen provider and `<PLACEHOLDER>` values for the
hand-filled fields. The synapse block is always emitted commented; the
per-datastack scaffolder owns synapse overrides.

Usage:
    # Full interactive
    uv run python scripts/scaffold_aligned_volume.py

    # Hybrid - name from flag, prompted for the rest
    uv run python scripts/scaffold_aligned_volume.py --name minnie65_phase3

    # Non-interactive - every value supplied
    uv run python scripts/scaffold_aligned_volume.py --non-interactive \\
        --name minnie65_phase3 --spatial-transform --provider cortex
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
_DEFAULT_CONFIG_DIR = _REPO_ROOT / "config" / "aligned_volumes"
_DEFAULT_PROVIDER = "cortex"


# ────────── Block templates ──────────
# Each block has prose (always emitted as comments) and body (emitted
# either uncommented or commented depending on the toggle). Inner `# `
# documentation comments inside the body survive both forms: they read
# as single-level comments when the block is enabled, and as
# double-commented prose ("# # foo") when the block is disabled.

_HEADER_TEMPLATE = """\
# Aligned-volume config for {name}.
#
# Carries the spatial transform (datastacks of the same volume share
# the coordinate frame) and synapse defaults (segmentation-pipeline-
# driven; shared across the volume's datastacks). Per-datastack YAMLs
# can override the synapse block field-by-field; spatial config can
# only be set here.
#
# This file is keyed by aligned_volume name (as reported by
# `client.info.get_datastack_info()['aligned_volume']['name']`), NOT
# by datastack. Every datastack mounted on the same volume reads the
# same file.

"""

_SPATIAL_PROSE = """\
# ---- spatial transform ------------------------------------------------
# Picks a registered SpatialProvider. `cortex` is the default and only
# bundled provider (handles minnie/v1dd-style cortical sheets); `null`
# emits no spatial columns at all (use for volumes you haven't
# characterized yet); a dotted import path lets you plug an out-of-tree
# provider that calls register_provider() at import time.
"""

# `provider` is substituted via .format(); the rest of the body is a
# single source of truth shared by both the on (uncommented) and off
# (commented) renderings.
_SPATIAL_BODY_TEMPLATE = """\
spatial:
  provider: {provider}
  params:
    # transform: short name for a standard_transform constructor.
    # Bundled names: minnie_nm, minnie_vx, v1dd_nm, v1dd_vx, identity.
    # The `_nm` variants expect positions in nanometres (Neuroglancer
    # native); `_vx` expects voxels. The transform maps input coords →
    # an oriented cortex frame where axis 1 is depth (pia → WM) and
    # axes 0/2 are tangential.
    transform: <TRANSFORM NAME>

    # depth_range: [pia_y, white_matter_y] in µm, post-transform.
    # The renderer uses this to set the default y-axis extent on
    # depth-bound plots.
    depth_range: [<PIA_UM>, <WM_UM>]

    # layer_boundaries: list of y-values (µm, post-transform) where
    # the renderer overlays cortical-layer guide lines. Order:
    # pia → white matter.
    layer_boundaries: [<UM>, <UM>, <UM>, <UM>, <UM>]

    # layer_names: one more name than boundaries (regions between).
    layer_names: [L1, L2/3, L4, L5, L6, WM]
"""

_SYNAPSE_PROSE = """\
# ---- synapse-table conventions ----------------------------------------
# The default schema applies to every CAVE synapse table on this volume.
# Per-datastack YAMLs can override individual fields without re-stating
# this whole block. Always emitted commented — uncomment + edit when
# the volume's synapse pipeline diverges from the defaults below.
"""

_SYNAPSE_BODY = """\
synapse:
  # Column-name stem for synapse position. Most CAVE synapse tables
  # use ctr_pt. Some pipelines use anchor_pt or post-anchor.
  position_prefix: ctr_pt

  # Projected columns. Setting to ~ (null) selects every column —
  # convenient for ad-hoc exploration, bloats the cache in production.
  columns:
    - id
    - pre_pt_root_id
    - post_pt_root_id
    - size
    - ctr_pt_position

  # Per-partner summary stats. Each entry adds a column to the
  # partner table by grouping synapses on partner root_id.
  aggregation_rules:
    mean_size:
      column: size
      agg: mean
    net_size:
      column: size
      agg: sum
"""


def _comment(body: str) -> str:
    """Prefix every line with '# '; blank lines become '#'."""
    return "\n".join("#" if not line.strip() else "# " + line for line in body.splitlines()) + "\n"


# ────────── Rendering ──────────


def _render_yaml(name: str, spatial_enabled: bool, provider: str) -> str:
    """Render the skeleton YAML body.

    When `spatial_enabled`, the spatial block is emitted uncommented
    with `provider` set; transform / depth_range / layer_boundaries are
    placeholder values the operator must fill in by hand. When off, the
    block is emitted commented with `cortex` as the provider example.
    """
    spatial_body = _SPATIAL_BODY_TEMPLATE.format(
        provider=provider if spatial_enabled else _DEFAULT_PROVIDER
    )
    spatial_block = _SPATIAL_PROSE + (spatial_body if spatial_enabled else _comment(spatial_body))
    synapse_block = _SYNAPSE_PROSE + _comment(_SYNAPSE_BODY)
    return _HEADER_TEMPLATE.format(name=name) + spatial_block + "\n" + synapse_block


# ────────── Interactive resolution ──────────


def _resolve_values(args: argparse.Namespace, console: Console) -> None:
    """Fill in unset args via prompts (interactive) or defaults/errors
    (non-interactive). Mutates `args` in place."""
    interactive = not args.non_interactive

    if interactive:
        console.print(
            Panel(
                "Scaffolding a new aligned-volume config.\n"
                "Press Enter to accept defaults. Pass --non-interactive to skip prompts.",
                title="scaffold_aligned_volume",
                border_style="cyan",
            )
        )

    # Naming arg — required; no sensible default.
    if args.name is None:
        if not interactive:
            console.print("[red]--non-interactive: --name is required[/]")
            raise SystemExit(2)
        args.name = Prompt.ask("Aligned-volume name", console=console).strip()
        if not args.name:
            console.print("[red]name cannot be empty[/]")
            raise SystemExit(2)

    # Spatial-block toggle. None means "not specified by flag"; default off.
    if args.spatial_transform is None:
        if interactive:
            args.spatial_transform = Confirm.ask(
                "Enable spatial-transform block?",
                default=False,
                console=console,
            )
        else:
            args.spatial_transform = False

    # Provider subprompt — only when the spatial block is on. Free-text
    # to accommodate `cortex`, `null`, or an out-of-tree dotted path.
    if args.spatial_transform and args.provider is None:
        if interactive:
            args.provider = Prompt.ask(
                "Spatial provider (cortex | null | dotted.module.path)",
                default=_DEFAULT_PROVIDER,
                console=console,
            ).strip() or _DEFAULT_PROVIDER
        else:
            args.provider = _DEFAULT_PROVIDER


# ────────── Main ──────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=textwrap.dedent(__doc__ or "").strip(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--name", default=None, help="aligned-volume name (filename basename)")
    parser.add_argument(
        "--spatial-transform",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="emit the spatial: block uncommented (default: commented)",
    )
    parser.add_argument(
        "--provider",
        default=None,
        help="spatial provider when --spatial-transform is on (cortex | null | dotted path). Default cortex.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output path (default: config/aligned_volumes/<name>.yaml)",
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

    out_path = args.out or (_DEFAULT_CONFIG_DIR / f"{args.name}.yaml")
    if out_path.exists() and not args.force:
        console.print(f"[red]refusing to overwrite existing file:[/] {out_path}")
        console.print("(pass --force to overwrite, or --out <path> to write elsewhere)")
        return 2

    provider = args.provider or _DEFAULT_PROVIDER
    rendered = _render_yaml(args.name, args.spatial_transform, provider)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(rendered)

    console.print(f"[green]wrote[/] {out_path}")
    console.print()
    console.print("[bold]Next:[/]")
    if args.spatial_transform:
        console.print(
            f"  1. Edit {out_path} — fill in transform / depth_range / layer_boundaries"
        )
        console.print("     (domain knowledge; not detectable from segmentation data).")
        console.print("  2. Uncomment + edit the synapse block if this volume diverges from defaults.")
    else:
        console.print(f"  1. Uncomment + edit blocks in {out_path} as needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
