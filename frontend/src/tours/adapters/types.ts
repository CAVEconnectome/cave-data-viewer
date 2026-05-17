/**
 * Per-kind recipe adapter contract.
 *
 * Every consumer of Recipe state — Sidebar's recipe list, the apply
 * confirmation dialog, the YAML uploader, ShareMenu's save action,
 * sessionRecipe's auto-restore — dispatches on `recipe.kind` to the
 * matching adapter rather than branching at the call site. That keeps
 * each consumer agnostic to kind-specific URL grammar or payload
 * shape, and means a future kind (e.g. /tables) lands as one new
 * adapter file plus an entry in `registry.ts`.
 *
 * The interface deliberately bottoms out at URLSearchParams because
 * URL state is the SPA's source of truth for everything that fits in
 * a URL. Things that don't fit — most notably the explorer's
 * Selection bag — travel via `RecipeMeta.extras`, NOT through the
 * URL. Adapters read/write those extras in `parseFromUrl` /
 * `applyToParams` as appropriate; consumers (e.g. ExplorerShareMenu)
 * supply the extras they have at save time, and consume the extras
 * the adapter exposes at apply time via the `applyExtras` callback.
 */
import type { Recipe, RecipeKind } from "../../api/types";

export interface RecipeMeta {
  id: string;
  title: string;
  description?: string;
  /** Adapter-specific state that doesn't live in the URL (e.g. the
   *  explorer's Selection bag). Each adapter documents what keys it
   *  reads from / writes to `extras`. Unrecognized keys are ignored
   *  so a consumer can supply a single extras object across kinds
   *  without worry. */
  extras?: Record<string, unknown>;
}

/** Adapter-driven diff used by the apply-confirmation toast. Each kind
 *  formats its own change summary; the consumer just renders the
 *  string. */
export interface RecipeDiffSummary {
  headline: string;
  lines: string[];
}

/** Single-kind handler. Generic over `R extends Recipe` so each
 *  adapter narrows to its arm of the union and can return / accept
 *  the concrete type. */
export interface RecipeKindAdapter<R extends Recipe> {
  /** Discriminator literal — matches `R["kind"]`. */
  kind: R["kind"];

  /** SPA route to navigate to when "Open"ing a recipe of this kind.
   *  Used by the landing page's Open button and by useApplyRecipe. */
  openRoute: "/neuron" | "/explore";

  /** Read a fresh recipe object from the current URL plus any
   *  adapter-specific extras (e.g. the explorer's Selection bag from
   *  a component-state hook). */
  parseFromUrl(params: URLSearchParams, meta: RecipeMeta): R;

  /** Whether the URL has anything worth saving as this kind of
   *  recipe. Used to disable the Save button when there's nothing to
   *  save. Adapters can also consult extras (e.g. the explorer
   *  considers a non-empty Selection bag to be content). */
  urlHasContent(params: URLSearchParams, meta?: RecipeMeta): boolean;

  /** Overlay the recipe onto an existing URLSearchParams. Replaces
   *  the kind's owned keys; passes through everything else. Returns a
   *  fresh URLSearchParams object — never mutates `prev`.
   *
   *  Adapters that have non-URL state to restore (e.g. the explorer's
   *  Selection bag) should call `applyExtras` with the relevant
   *  payload when supplied. Consumers that don't need extras
   *  restoration omit the callback. */
  applyToParams(
    prev: URLSearchParams,
    recipe: R,
    applyExtras?: (extras: Record<string, unknown>) => void,
  ): URLSearchParams;

  /** Build the full URL param set for landing-page "Open." `mv` is
   *  the caller's currently-selected materialization version (the
   *  sidebar's pick) — recipes don't pin mv themselves. */
  buildOpenParams(
    ds: string,
    recipe: R,
    mv: string | null,
  ): URLSearchParams;

  /** Whether `prev` already has enough context to apply this recipe
   *  in-place. For connectivity that means a `?root=` is set; for
   *  explorer it means `?ds=` is set (explorer doesn't require a
   *  loaded neuron). When false, useApplyRecipe routes through the
   *  Open path instead of overlaying. */
  hasNavContext(prev: URLSearchParams): boolean;

  /** Emit the recipe as a YAML document. Connectivity uses the
   *  hand-rolled emitter for operator-YAML paste fidelity; explorer
   *  uses js-yaml because its nested shape is deeper than the
   *  hand-rolled emitter handles. */
  toYaml(recipe: R): string;

  /** Parse a YAML mapping into a recipe of this kind. Returns null
   *  if the parsed shape doesn't match — caller (the upload handler)
   *  collects nulls as errors. */
  fromYaml(parsed: unknown, meta: RecipeMeta): R | null;

  /** Short human-readable summary of what'll change when this recipe
   *  is applied to `prev`. Rendered in the confirmation dialog. */
  diff(prev: URLSearchParams, recipe: R): RecipeDiffSummary;
}

/** Convenience alias for code that holds adapters without a specific
 *  arm narrowing. The registry uses this on its return type. */
export type AnyRecipeKindAdapter = RecipeKindAdapter<Recipe>;

/** Map kind → adapter. Populated by `registry.ts`. */
export type RecipeKindAdapterMap = {
  [K in RecipeKind]: RecipeKindAdapter<Extract<Recipe, { kind: K }>>;
};
