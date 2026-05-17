/**
 * Registry of per-kind adapters. Every consumer of Recipe state
 * routes through `adapterFor(kind)` or `adapterForRecipe(recipe)`
 * to pick the right adapter, instead of branching on `recipe.kind`
 * at the call site.
 *
 * Adding a new kind = (1) extend RecipeKind in api/types.ts, (2) add
 * a Recipe arm there, (3) write an adapter, (4) register it here.
 * Consumers don't change.
 */
import type { Recipe, RecipeKind } from "../../api/types";
import { connectivityAdapter } from "./connectivityAdapter";
import { explorerAdapter } from "./explorerAdapter";
import type { AnyRecipeKindAdapter, RecipeKindAdapterMap } from "./types";

export const ADAPTERS: RecipeKindAdapterMap = {
  connectivity: connectivityAdapter,
  explorer: explorerAdapter,
};

/** Look up an adapter by kind. Throws when no adapter exists — the
 *  expectation is that consumers narrow `kind` against `RecipeKind`
 *  (the type system enforces it), so reaching this throw means a
 *  recipe with a future/unknown kind made it through the parser. */
export function adapterFor(kind: RecipeKind): AnyRecipeKindAdapter {
  const a = ADAPTERS[kind] as AnyRecipeKindAdapter | undefined;
  if (!a) throw new Error(`no adapter for recipe kind: ${kind}`);
  return a;
}

export function adapterForRecipe(r: Recipe): AnyRecipeKindAdapter {
  return adapterFor(r.kind);
}

/** All kinds the SPA knows about. Useful for filtering server-side
 *  lists against client-known kinds (a newer server might ship a
 *  kind this SPA hasn't been built for). */
export const ALL_KINDS: ReadonlyArray<RecipeKind> = ["connectivity", "explorer"];
