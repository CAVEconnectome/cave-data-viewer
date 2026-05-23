/**
 * Round-trip tests for the recipe adapters — the interface layer that
 * carries saved-view state between /explore and /neuron.
 *
 * Core invariant: a recipe survives URL -> recipe -> URL (and, for the
 * explorer, YAML -> recipe -> YAML) unchanged. The explorer adapter's
 * field set is driven by one descriptor table (EXPLORER_FIELDS); these
 * tests populate every field at once so a dropped field fails loudly
 * and names itself in the diff.
 */
import { describe, it, expect } from "vitest";
import { load as yamlLoad } from "js-yaml";

import { explorerAdapter } from "./explorerAdapter";
import { connectivityAdapter } from "./connectivityAdapter";
import type { ConnectivityRecipe, ExplorerRecipe } from "../../api/types";

const META = {
  id: "personal-test-0001",
  title: "Test recipe",
  description: "desc",
};

// An explorer recipe with every URL-backed field set to a distinct
// non-default value, plus a Selection bag. If any adapter path drops a
// field, the round-trip `toEqual` names it.
const FULL_EXPLORER: ExplorerRecipe = {
  id: META.id,
  title: META.title,
  description: META.description,
  kind: "explorer",
  explorer: {
    ft: "feature_table_v1",
    emb: "umap_2d",
    decoration_tables: ["cell_type", "proofreading"],
    cells: "cell_type.cell_type:eq:5P",
    scope_mode: "hide",
    sel_filters: ["cell_type.cell_type:eq:5P", "proofreading.status:eq:done"],
    x: "umap_0",
    y: "umap_1",
    color: "cell_type.cell_type",
    size: "n_syn",
    cmap: "viridis",
    color_min: 0,
    color_max: 12.5,
    color_center: 6,
    size_min: 2,
    size_max: 18,
    size_data_min: 1,
    size_data_max: 400,
    growth_space: "pca",
    growth_variance: 0.9,
    growth_reduction: "mahalanobis",
    growth_threshold: 0.25,
    growth_features: ["umap_0", "umap_1", "umap_2"],
    growth_topn: 25,
    selection: ["100001", "100002", "100003"],
  },
};

describe("explorerAdapter round-trip", () => {
  it("URL round-trip preserves every explorer field", () => {
    let captured: Record<string, unknown> | undefined;
    const params = explorerAdapter.applyToParams(
      new URLSearchParams(),
      FULL_EXPLORER,
      (extras) => {
        captured = extras;
      },
    );
    const back = explorerAdapter.parseFromUrl(params, {
      ...META,
      extras: { selection: (captured?.selection as string[]) ?? [] },
    });
    expect(back).toEqual(FULL_EXPLORER);
  });

  it("YAML round-trip preserves every explorer field", () => {
    const yaml = explorerAdapter.toYaml(FULL_EXPLORER);
    const parsed = yamlLoad(yaml) as { recipes: unknown[] };
    const back = explorerAdapter.fromYaml(parsed.recipes[0], META);
    expect(back).toEqual(FULL_EXPLORER);
  });

  it("an empty explorer recipe round-trips to the normalized empty form", () => {
    const empty: ExplorerRecipe = {
      id: META.id,
      title: META.title,
      description: META.description,
      kind: "explorer",
      explorer: { selection: [] },
    };
    let captured: Record<string, unknown> | undefined;
    const params = explorerAdapter.applyToParams(
      new URLSearchParams(),
      empty,
      (extras) => {
        captured = extras;
      },
    );
    const back = explorerAdapter.parseFromUrl(params, {
      ...META,
      extras: { selection: (captured?.selection as string[]) ?? [] },
    });
    // stateFromParams fills every field — null for absent scalars, [] for lists.
    expect(back.explorer.ft).toBeNull();
    expect(back.explorer.decoration_tables).toEqual([]);
    expect(back.explorer.selection).toEqual([]);
  });
});

describe("connectivityAdapter round-trip", () => {
  it("URL round-trip preserves decoration_tables, cells, hide, show, coll", () => {
    const recipe: ConnectivityRecipe = {
      id: META.id,
      title: META.title,
      description: META.description,
      kind: "connectivity",
      decoration_tables: ["cell_type", "proofreading"],
      plots: [],
      cells: "cell_type.cell_type:eq:5P",
      hide: ["col_a", "col_b"],
      show: ["col_c"],
      coll: ["group_x"],
    };
    const params = connectivityAdapter.applyToParams(new URLSearchParams(), recipe);
    const back = connectivityAdapter.parseFromUrl(params, META);
    expect(back.kind).toBe("connectivity");
    expect(back.decoration_tables).toEqual(recipe.decoration_tables);
    expect(back.cells).toBe(recipe.cells);
    expect(back.hide).toEqual(recipe.hide);
    expect(back.show).toEqual(recipe.show);
    expect(back.coll).toEqual(recipe.coll);
  });
});
