"""Minimal reproducer for the "hidden segments aren't actually hidden"
issue in nglui's `add_segments` dict form.

Run:
    cd /Users/caseysm/Work/Code/cave-diver
    uv run python scripts/debug_ngl_hidden_segments.py

Each test prints the layer's segments dict + the rendered Neuroglancer
state JSON (the part that matters: `layers[1].segments` and
`layers[1].visible_segments`). What we want: 3 segments listed, only
2 of them visible. What we expect to see if the bug is real: all 3
visible, or all 3 hidden, or only the True ones present.

Three paths:
  1. nglui's `add_segments(dict)` form    — what CAVE Diver uses
  2. nglui's `add_segments(list, visible)` form — alternate API
  3. Raw neuroglancer.StarredSegments      — bypasses nglui entirely
"""

from __future__ import annotations

import json

from neuroglancer.viewer_state import SegmentationLayer as NgSegLayer
from neuroglancer.viewer_state import StarredSegments
from nglui.statebuilder.base import ViewerState
from nglui.statebuilder.ngl_components import SegmentationLayer


# Three made-up uint64 segment ids — visible[0,1], hidden[2].
SEGS = [864691135000000001, 864691135000000002, 864691135000000003]
VISIBILITY = {SEGS[0]: True, SEGS[1]: True, SEGS[2]: False}


def show_layer(label: str, layer) -> None:
    print(f"\n=== {label} ===")
    # The nglui layer's stored segments dict (what we set).
    print(f"  nglui layer.segments = {layer.segments!r}")
    # Convert to a Neuroglancer state layer and inspect the resulting
    # StarredSegments — this is what gets serialized into the URL.
    ng_layer = layer.to_neuroglancer_layer()
    print(f"  neuroglancer starred_segments._data    = {dict(ng_layer.starred_segments._data)!r}")
    print(f"  neuroglancer starred_segments._visible = {dict(ng_layer.starred_segments._visible)!r}")
    # JSON the layer renders into the state.
    layer_json = ng_layer.to_json()
    print(f"  layer JSON 'segments': {layer_json.get('segments')!r}")


def test_dict_form() -> None:
    """What CAVE Diver does: pass a dict {id: bool} to add_segments."""
    layer = SegmentationLayer(name="seg", source="precomputed://dummy")
    layer.add_segments(segments=dict(VISIBILITY))
    show_layer("Test 1: nglui add_segments(dict)", layer)


def test_list_visible_form() -> None:
    """Alternate nglui API: separate list + visible parallel arrays."""
    layer = SegmentationLayer(name="seg", source="precomputed://dummy")
    visible_flags = [VISIBILITY[s] for s in SEGS]
    layer.add_segments(segments=SEGS, visible=visible_flags)
    show_layer("Test 2: nglui add_segments(list, visible=[…])", layer)


def test_raw_neuroglancer() -> None:
    """Bypass nglui: build a Neuroglancer SegmentationLayer directly,
    pass the visibility dict to the `starred_segments` property (which
    routes through StarredSegments._update). If THIS works, the bug is
    in nglui's choice to use visible_segments= instead of
    starred_segments=. If it doesn't, the bug runs deeper.

    Note: do NOT pre-construct a StarredSegments and assign it — the
    setter calls _update(other_starred_segments), which has its own
    bug (iterates `other._data` as if it were tuples instead of keys
    — see neuroglancer/viewer_state.py:678). Pass a plain dict to
    dodge that path entirely."""
    ng_layer = NgSegLayer(source="precomputed://dummy")
    ng_layer.starred_segments = dict(VISIBILITY)
    print("\n=== Test 3: raw neuroglancer SegmentationLayer + starred_segments=dict ===")
    print(f"  starred._data    = {dict(ng_layer.starred_segments._data)!r}")
    print(f"  starred._visible = {dict(ng_layer.starred_segments._visible)!r}")
    print(f"  layer JSON 'segments': {ng_layer.to_json().get('segments')!r}")


def test_end_to_end_viewer_json() -> None:
    """Full viewer JSON via the path CAVE Diver uses. Print the
    relevant chunk so we can see what would land in a shortened
    state-server entry."""
    viewer = ViewerState(infer_coordinates=False)
    layer = SegmentationLayer(name="seg", source="precomputed://dummy")
    layer.add_segments(segments=dict(VISIBILITY))
    viewer.add_layer(layer)
    state = viewer.to_dict()
    seg_layer_json = next(
        (lyr for lyr in state.get("layers", []) if lyr.get("name") == "seg"),
        None,
    )
    print("\n=== Test 4: full viewer state JSON (the seg layer slice) ===")
    print(json.dumps(seg_layer_json, indent=2))


if __name__ == "__main__":
    test_dict_form()
    test_list_visible_form()
    test_raw_neuroglancer()
    test_end_to_end_viewer_json()
    print(
        "\nExpected for 'segments' in JSON: a list including '!864691135000000003' "
        "(or equivalent) to mark id #3 as hidden-but-loaded. Neuroglancer's URL "
        "format uses a leading '!' on hidden segment ids."
    )
