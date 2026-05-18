"""Scaffold a config/aligned_volumes/<name>.yaml skeleton.

Aligned-volume YAMLs are typically hand-authored — spatial transform
parameters are domain knowledge (where the cortex starts, what the
layer boundaries are at this volume's scale) that can't be inferred
from segmentation data. The scaffolder emits a heavily-commented
skeleton with every common knob present; operator fills in the
transform fields by hand.

Usage:
    uv run python scripts/scaffold_aligned_volume.py --name minnie65_phase3

Options:
    --name <name>   (required) aligned-volume name; used as filename.
    --out <path>    Override output path (default: config/aligned_volumes/<name>.yaml).
    --force         Overwrite an existing file.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence


TEMPLATE = """\
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

# ---- spatial transform ------------------------------------------------
# Picks a registered SpatialProvider. `cortex` is the default and only
# bundled provider (handles minnie/v1dd-style cortical sheets); `null`
# emits no spatial columns at all (use for volumes you haven't
# characterized yet); `provider_module` lets you plug an out-of-tree
# provider via a dotted import path that calls register_provider() at
# import time.
#
# spatial:
#   provider: cortex
#   params:
#     # transform: 4x4 affine that maps Neuroglancer-space (nm) → cortex
#     # space (µm, y-axis = depth, x/z = tangential). Hand-authored from
#     # registration. The translation column is in µm post-transform.
#     transform:
#       - [1.0, 0.0, 0.0, 0.0]
#       - [0.0, 1.0, 0.0, 0.0]
#       - [0.0, 0.0, 1.0, 0.0]
#       - [0.0, 0.0, 0.0, 1.0]
#
#     # depth_range: [pia_y, white_matter_y] in µm, post-transform.
#     # The renderer uses this to set the default y-axis extent on
#     # depth-bound plots.
#     depth_range: [0.0, 1500.0]
#
#     # layer_boundaries: list of y-values (µm, post-transform) where
#     # the renderer overlays cortical-layer guide lines. Order:
#     # pia → white matter.
#     layer_boundaries: [120.0, 400.0, 600.0, 900.0, 1200.0]
#
#     # layer_names: one more name than boundaries (regions between).
#     layer_names: [L1, L2/3, L4, L5, L6, WM]

# ---- synapse-table conventions ----------------------------------------
# The default schema applies to every CAVE synapse table on this volume.
# Per-datastack YAMLs can override individual fields without re-stating
# this whole block.
#
# synapse:
#   # Column-name stem for synapse position. Most CAVE synapse tables
#   # use ctr_pt. Some pipelines use anchor_pt or post-anchor.
#   position_prefix: ctr_pt
#
#   # Projected columns. Setting to ~ (null) selects every column —
#   # convenient for ad-hoc exploration, bloats the cache in production.
#   columns:
#     - id
#     - pre_pt_root_id
#     - post_pt_root_id
#     - size
#     - ctr_pt_position
#
#   # Per-partner summary stats. Each entry adds a column to the
#   # partner table by grouping synapses on partner root_id.
#   aggregation_rules:
#     mean_size:
#       column: size
#       agg: mean
#     net_size:
#       column: size
#       agg: sum
"""


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True,
                   help="aligned-volume name (filename basename)")
    p.add_argument("--out", type=Path, default=None,
                   help="output path (default: config/aligned_volumes/<name>.yaml)")
    p.add_argument("--force", action="store_true",
                   help="overwrite an existing file")
    args = p.parse_args(argv)

    if args.out is not None:
        out_path = args.out
    else:
        repo_root = Path(__file__).resolve().parents[1]
        out_path = repo_root / "config" / "aligned_volumes" / f"{args.name}.yaml"
        out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.exists() and not args.force:
        print(f"refusing to overwrite {out_path} (pass --force to override)", file=sys.stderr)
        return 1

    out_path.write_text(TEMPLATE.format(name=args.name))
    print(f"wrote: {out_path}")
    print(
        "edit the spatial.params block (transform, depth_range, "
        "layer_boundaries, layer_names) by hand — spatial parameters "
        "are domain knowledge, not detectable from a parquet."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
