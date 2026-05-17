"""Tiny histogram summaries of feature columns.

Backs the ``GET /column/<col>/histogram`` endpoint and the
SelectionBuilder's first-paint display path. Three properties make this
worth a separate cache:

1. **Tiny payload.** A 60-bin numeric histogram is ~hundred-ish bytes
   on the wire vs. ~750KB for the full ``/column`` response. L2-hit
   round trips in tens of milliseconds.
2. **Immutable.** The underlying parquet content is pinned by URI;
   decoration snapshots are pinned by mat_version. A ``(ds, ft, column,
   dec, mv, bins)`` tuple uniquely determines the histogram forever.
3. **Highly shared.** Every user opening the SelectionBuilder on the
   same column hits the same entry — one writer warms the cache, the
   rest read.

The companion ``/column`` route still ships the full universe-aligned
values for callers that need per-cell-id masks (e.g. the SelectionBuilder
intersection step). The histogram is purely a display-tier accelerant.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import pandas as pd

from ..timing import timer


# Binning modes for numeric columns. ``linear`` = equal-width bins
# between the min and max (the existing default). ``log`` = bin edges
# spaced exponentially on the value axis — finer resolution at the
# small end where most cells live for heavy-tailed connectomics
# features like synapse counts or volumes. Log binning is undefined
# when any value is <= 0; the helper falls back to linear in that
# case and the response carries ``binning: "linear"`` so the SPA
# knows what it got.
Binning = Literal["linear", "log"]


@dataclass
class NumericColumnHistogram:
    """Summary of a numeric column.

    ``bin_edges`` carries the full edge sequence (length ``n_bins + 1``)
    in original value space. For linear binning the edges are equal-
    width; for log binning they're exponentially spaced. Shipping the
    edges explicitly (rather than just min/max + assuming equal-width)
    is what lets the SPA render log-binned histograms without
    re-deriving the spacing.

    ``bin_min`` and ``bin_max`` mirror ``bin_edges[0]`` and ``bin_edges[-1]``
    for callers that only need the extent.

    ``n_null`` accumulates rows that were null or non-finite; they don't
    appear in ``bin_counts`` but the caller may want to surface a
    "missing N cells" badge.
    """

    kind: str  # "numeric"
    bin_min: float
    bin_max: float
    bin_edges: list[float]
    bin_counts: list[int]
    binning: Binning
    n_finite: int
    n_null: int
    # When True, the request asked for ``binning=log`` but the values
    # included non-positive entries so the response fell back to
    # linear. Lets the SPA surface "log unavailable" rather than
    # silently showing linear.
    log_fallback: bool = False


@dataclass
class CategoricalColumnHistogram:
    """Summary of a categorical column: per-value counts.

    ``value_counts`` is sorted descending by count so the dominant
    categories surface first in any UI that consumes the response.
    Capped at ``max_values`` distinct entries — columns with thousands
    of distinct strings would defeat the "tiny payload" property; the
    SPA falls back to fetching the full ``/column`` if it needs the
    tail.
    """

    kind: str  # "categorical"
    value_counts: list[tuple[str, int]]
    n_null: int
    truncated: bool


def compute_numeric_histogram(
    series: pd.Series, n_bins: int = 60, *, binning: Binning = "linear"
) -> NumericColumnHistogram:
    """Bin a numeric pandas Series into ``n_bins`` bins.

    ``binning`` controls the edge spacing: ``linear`` (default) gives
    equal-width bins between the min and max; ``log`` gives
    exponentially-spaced edges, which makes heavy-tailed distributions
    readable at the small end.

    Log binning silently falls back to linear when any value is <= 0
    (the log of a non-positive number is undefined); the returned
    histogram carries ``log_fallback=True`` so the SPA can surface
    the situation rather than silently treating the chart as log.

    Uses numpy under the hood; ~ms for 100k rows.
    """
    with timer("histogram_numeric_compute"):
        return _compute_numeric_histogram(series, n_bins, binning=binning)


def _compute_numeric_histogram(
    series: pd.Series, n_bins: int, *, binning: Binning
) -> NumericColumnHistogram:
    coerced = pd.to_numeric(series, errors="coerce")
    finite_mask = np.isfinite(coerced.to_numpy(dtype=np.float64))
    n_total = len(coerced)
    n_finite = int(finite_mask.sum())
    n_null = n_total - n_finite

    if n_finite == 0:
        edges = [0.0] * (n_bins + 1)
        return NumericColumnHistogram(
            kind="numeric",
            bin_min=0.0,
            bin_max=0.0,
            bin_edges=edges,
            bin_counts=[0] * n_bins,
            binning="linear",
            n_finite=0,
            n_null=n_null,
        )

    values = coerced.to_numpy(dtype=np.float64)[finite_mask]
    mn = float(values.min())
    mx = float(values.max())

    if mx == mn:
        # Constant column → degenerate one-bar histogram. Honest
        # representation; SPA renders without a special case because
        # the edge sequence still has n_bins+1 entries.
        edges = [mn] * (n_bins + 1)
        counts = [0] * n_bins
        counts[0] = n_finite
        return NumericColumnHistogram(
            kind="numeric",
            bin_min=mn,
            bin_max=mx,
            bin_edges=edges,
            bin_counts=counts,
            binning="linear",
            n_finite=n_finite,
            n_null=n_null,
        )

    # Resolve the binning mode + fall back when log is undefined.
    log_fallback = False
    effective_binning: Binning = binning
    if binning == "log" and mn <= 0:
        effective_binning = "linear"
        log_fallback = True

    if effective_binning == "log":
        # Geometric spacing in original value space.
        edges_arr = np.geomspace(mn, mx, n_bins + 1)
    else:
        edges_arr = np.linspace(mn, mx, n_bins + 1)

    counts, _ = np.histogram(values, bins=edges_arr)
    return NumericColumnHistogram(
        kind="numeric",
        bin_min=mn,
        bin_max=mx,
        bin_edges=[float(e) for e in edges_arr.tolist()],
        bin_counts=[int(c) for c in counts.tolist()],
        binning=effective_binning,
        n_finite=n_finite,
        n_null=n_null,
        log_fallback=log_fallback,
    )


def compute_categorical_histogram(
    series: pd.Series, max_values: int = 200
) -> CategoricalColumnHistogram:
    """Per-value counts for a categorical column, sorted descending.

    Stringified so the wire format is uniform. ``max_values`` caps the
    response size — a column with thousands of distinct values isn't
    a meaningful filter dimension anyway and would defeat the cache's
    size benefit. ``truncated`` lets the SPA show "(capped)".
    """
    with timer("histogram_categorical_compute"):
        return _compute_categorical_histogram(series, max_values)


def _compute_categorical_histogram(
    series: pd.Series, max_values: int
) -> CategoricalColumnHistogram:
    stringified = series.astype(str)
    null_mask = series.isna()
    n_null = int(null_mask.sum())
    counts = stringified[~null_mask].value_counts()
    truncated = len(counts) > max_values
    top = counts.head(max_values)
    return CategoricalColumnHistogram(
        kind="categorical",
        value_counts=[(str(k), int(v)) for k, v in top.items()],
        n_null=n_null,
        truncated=truncated,
    )


def histogram_to_json(
    h: NumericColumnHistogram | CategoricalColumnHistogram,
) -> dict[str, Any]:
    """Convert a histogram dataclass to the JSON shape served on the
    wire. Kept here (not in the endpoint) so the cache stores the
    response-shaped dict; readers don't re-format on every hit."""
    if isinstance(h, NumericColumnHistogram):
        return {
            "kind": "numeric",
            "bin_min": h.bin_min,
            "bin_max": h.bin_max,
            "bin_edges": h.bin_edges,
            "bin_counts": h.bin_counts,
            "binning": h.binning,
            "n_finite": h.n_finite,
            "n_null": h.n_null,
            "log_fallback": h.log_fallback,
        }
    return {
        "kind": "categorical",
        "value_counts": [
            {"value": v, "count": c} for v, c in h.value_counts
        ],
        "n_null": h.n_null,
        "truncated": h.truncated,
    }
