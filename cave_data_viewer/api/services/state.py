"""Building blocks for Neuroglancer ViewerState composition.

Each function here does one composable thing: create a viewer, pin segments,
build an annotation layer from a synapse dataframe, render to a URL. The link
template resolver in `services/links.py` is the only orchestrator — when we
extend visual behavior (cell-type-grouped annotations, supervoxel-id segments
in live mode, custom shaders, annotation properties), the new builder lands
*here* and is called from there.

The module deliberately avoids any knowledge of LinkTemplate, NeuronQuery, or
the request layer — it only knows about pandas DataFrames, nglui types, and
basic primitives. Keep it that way.
"""

from typing import Iterable

import pandas as pd
from nglui.statebuilder.base import ViewerState
from nglui.statebuilder.ngl_annotations import PointAnnotation
from nglui.statebuilder.ngl_components import AnnotationLayer
from nglui.statebuilder.shaders import simple_point_shader


# ----- viewer-level helpers ---------------------------------------------------

def new_viewer_state(client) -> ViewerState:
    """Create a ViewerState with the datastack's image + segmentation layers attached."""
    return ViewerState(infer_coordinates=True).add_layers_from_client(client)


def pin_segments(
    viewer: ViewerState,
    segments: Iterable[int],
    *,
    colors: dict[int, str] | None = None,
) -> ViewerState:
    """Add segments to the segmentation layer, optionally with per-id colors.

    `add_layers_from_client` puts segmentation at layer index 1 by convention
    (image is index 0). If a deployment customizes layer order, override here.

    `colors` is a `{segment_id: css_color}` map fed straight into nglui's
    `add_segment_colors` — useful for distinguishing the focal neuron from
    partners (e.g. `{root_id: "white"}` to mark the queried cell).
    """
    seg_layer = viewer.layers[1]
    seg_layer.add_segments(segments=list(segments))
    if colors:
        seg_layer.add_segment_colors(colors)
    return viewer


def set_view_position(
    viewer: ViewerState,
    *,
    position: list[float],
    dimensions: list[float] | None = None,
) -> ViewerState:
    """Center the viewer on `position`, interpreting it in `dimensions`.

    `position` is a 3-list `[x, y, z]`; `dimensions` is `[r_x, r_y, r_z]`
    in nm-per-unit. When `dimensions` matches the table's voxel_resolution
    (e.g. `[4, 4, 40]`), `position` can be passed in raw voxel coordinates
    straight from a `pt_position_x/y/z` column triple — nglui builds the
    CoordSpace and Neuroglancer renders the position in the right place
    without any nm conversion at our layer.

    Pass `dimensions=None` to skip the dimension override; nglui will use
    whatever `infer_coordinates` produced from the segmentation layer,
    and `position` is then interpreted in those default units (typically nm).
    """
    if dimensions is not None:
        viewer.set_viewer_properties(position=position, dimensions=dimensions)
    else:
        viewer.set_viewer_properties(position=position)
    return viewer


def render_url(
    viewer: ViewerState,
    *,
    target_url: str,
    shorten: str,
    client,
) -> tuple[str, bool]:
    """Render the viewer state to a URL. Returns `(url, was_shortened)`.

    `shorten` follows nglui's contract: "if_long" / "always" / "never". The
    CAVE state-server form looks like `…#!middleauth+<server>/nglstate/api/v1/<id>`.
    """
    url = viewer.to_url(
        target_url=target_url,
        shorten=False if shorten == "never" else shorten,
        client=client,
    )
    return url, "nglstate/api/v1/" in url


# ----- shader helpers ---------------------------------------------------------

def resolve_shader(shader_template: str | bool, *, color: str | None = None) -> str | None:
    """Map a LinkTemplate `shader: True | False | "<glsl>"` field to nglui's
    expected `shader=` value (default-points-shader / no shader / raw GLSL).

    The default points shader bakes its `markerColor` UI default into the GLSL
    string, and that default wins over `AnnotationLayer.color` at render time.
    Build the shader with the layer's color so the two are consistent — without
    this, multiple layers in one viewer collapse to a single color.
    """
    if shader_template is True:
        return simple_point_shader(color=color or "tomato")
    if shader_template is False:
        return None
    return shader_template


# ----- df-shaping helpers -----------------------------------------------------

def sort_to_partner_order(
    df: pd.DataFrame,
    *,
    partner_col: str,
    partner_order: Iterable[int],
) -> pd.DataFrame:
    """Order rows so all of a partner's synapses are contiguous, with partners
    appearing in `partner_order`. The SPA's partners table is sorted by
    `num_syn` desc; passing that order keeps the annotation list visually
    aligned with the table.
    """
    if df.empty:
        return df
    rank = {p: i for i, p in enumerate(partner_order)}
    return (
        df.assign(_rank=df[partner_col].map(rank))
          .sort_values("_rank", kind="stable")
          .drop(columns="_rank")
          .reset_index(drop=True)
    )


# ----- annotation builders ----------------------------------------------------

def synapse_point_annotations(
    df: pd.DataFrame,
    *,
    position_prefix: str,
    segments_columns: tuple[str, str],
    data_resolution: list[float],
) -> list[PointAnnotation]:
    """Build PointAnnotation objects from a synapse df.

    Each annotation links BOTH ids named in `segments_columns` so clicking a
    synapse in Neuroglancer toggles both partners in the segmentation layer.
    Typical pairs:
      - materialized:  ("pre_pt_root_id",      "post_pt_root_id")
      - live (future): ("pre_pt_supervoxel_id","post_pt_supervoxel_id") —
        Neuroglancer does its own chunkedgraph lookup, so links stay correct
        across proofreading. See memory: supervoxel_id_live_lookup_trick.
    """
    if df.empty:
        return []
    pos_x = f"{position_prefix}_position_x"
    pos_y = f"{position_prefix}_position_y"
    pos_z = f"{position_prefix}_position_z"
    a_col, b_col = segments_columns

    # Vectorized column extraction; iterrows is the slow path. ~30ms vs ~250ms
    # for ~10k rows.
    xs = df[pos_x].to_numpy()
    ys = df[pos_y].to_numpy()
    zs = df[pos_z].to_numpy()
    a_ids = df[a_col].to_numpy()
    b_ids = df[b_col].to_numpy()
    return [
        PointAnnotation(
            point=[float(x), float(y), float(z)],
            segments=[int(a), int(b)],
            resolution=data_resolution,
        )
        for x, y, z, a, b in zip(xs, ys, zs, a_ids, b_ids)
    ]


def synapse_layer(
    df: pd.DataFrame,
    *,
    layer_name: str,
    color: str,
    shader_template: str | bool,
    position_prefix: str,
    segments_columns: tuple[str, str],
    data_resolution: list[float],
) -> AnnotationLayer:
    """One AnnotationLayer rendering every row of `df` as a point. Each
    annotation's linked segments include both columns of `segments_columns`.

    To add cell-type-grouped layers, build one of these per group with a
    different `layer_name`/`color`, splitting `df` by the cell-type column.
    """
    layer = AnnotationLayer(
        name=layer_name,
        linked_segmentation="segmentation",
        shader=resolve_shader(shader_template, color=color),
        color=color,
    )
    layer.add_annotations(synapse_point_annotations(
        df,
        position_prefix=position_prefix,
        segments_columns=segments_columns,
        data_resolution=data_resolution,
    ))
    return layer
