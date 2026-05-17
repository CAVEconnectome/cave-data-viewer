/**
 * Parse user-uploaded YAML into Recipe objects.
 *
 * Permissive about input shape: accepts either
 *
 *   recipes:
 *     - id: foo
 *       title: ...
 *     - id: bar
 *       title: ...
 *
 * or a single recipe object at the document root:
 *
 *   id: foo
 *   title: ...
 *
 * Each loaded recipe gets a fresh `personal-` id (the YAML's `id`, if
 * present, becomes a label suffix in the description so the user can
 * trace the source) so it can never collide with operator ids or
 * other personal entries.
 *
 * Validation is intentionally lenient — operator-curated YAMLs go
 * through PyDantic on the server, but user-pasted YAMLs come from
 * humans typing things by hand. We salvage what we can: missing
 * decoration_tables → []; malformed plot entries → dropped with a
 * warning in the result. The only hard requirement is `title` (so the
 * sidebar has something to render).
 */
import { JSON_SCHEMA, load as yamlLoad } from "js-yaml";
import type { Recipe, RecipeKind, RecipeScope, ScopePredicate, ScopePredicateOp } from "../api/types";
import { newPersonalId } from "./personalRecipes";
import { adapterFor, ALL_KINDS } from "./adapters/registry";

export interface RecipeParseResult {
  recipes: Recipe[];
  warnings: string[];
  errors: string[];
}

// Hardening: cap input size before handing it to the YAML parser. A
// hostile (or accidentally enormous) blob shouldn't be able to OOM the
// tab. 256 KB is generous — the recipe shape is shallow and any plausible
// hand-authored YAML lands in the low single-digit KB. Bigger files are
// almost certainly mis-uploads (a downloaded notebook, a config dump, a
// PDF saved with the wrong extension).
const MAX_YAML_BYTES = 256 * 1024;

export function parseRecipesFromYaml(yamlText: string): RecipeParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  // Use byte length, not string length — the cap is about parser work, not
  // character count. A 256 KB UTF-8 blob is the same parse cost regardless
  // of whether it's ASCII or multi-byte.
  const byteLength = new Blob([yamlText]).size;
  if (byteLength > MAX_YAML_BYTES) {
    errors.push(
      `YAML is too large (${(byteLength / 1024).toFixed(0)} KB; limit ${MAX_YAML_BYTES / 1024} KB). ` +
        "Recipe YAMLs are typically a few KB — check that you uploaded the right file.",
    );
    return { recipes: [], warnings, errors };
  }
  let parsed: unknown;
  try {
    // JSON_SCHEMA restricts the parser to the YAML subset that overlaps
    // with JSON (strings, numbers, booleans, null, sequences, mappings).
    // Recipes never use anchors, custom tags, octal/hex literals, or YAML-
    // only scalars — tightening here closes the door on future js-yaml
    // CVEs scoped to those features without changing what we accept.
    parsed = yamlLoad(yamlText, { schema: JSON_SCHEMA });
  } catch (e) {
    errors.push(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
    return { recipes: [], warnings, errors };
  }
  if (parsed == null) {
    errors.push("YAML is empty.");
    return { recipes: [], warnings, errors };
  }

  // Normalize input shape into an array of candidate recipe objects.
  let candidates: unknown[];
  if (isRecord(parsed) && Array.isArray((parsed as Record<string, unknown>).recipes)) {
    candidates = (parsed as Record<string, unknown>).recipes as unknown[];
  } else if (Array.isArray(parsed)) {
    // Bare array is also accepted (`- id: ... ` at document root).
    candidates = parsed;
  } else if (isRecord(parsed)) {
    // Single recipe at document root.
    candidates = [parsed];
  } else {
    errors.push("YAML must be a recipe object, a list of recipe objects, or a `recipes:` map.");
    return { recipes: [], warnings, errors };
  }

  const recipes: Recipe[] = [];
  candidates.forEach((raw, i) => {
    const result = coerceRecipe(raw, i);
    if (result.recipe) recipes.push(result.recipe);
    warnings.push(...result.warnings);
    errors.push(...result.errors);
  });

  if (recipes.length === 0 && errors.length === 0) {
    errors.push("No usable recipes found in YAML.");
  }
  return { recipes, warnings, errors };
}

export function parseScopeBlock(raw: unknown, _where: string): RecipeScope | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object") return undefined;
  const preds = (raw as Record<string, unknown>).predicates;
  if (!Array.isArray(preds)) return undefined;
  const out: ScopePredicate[] = [];
  for (const p of preds) {
    if (typeof p !== "object" || p == null) continue;
    const r = p as Record<string, unknown>;
    if (typeof r.column !== "string" || typeof r.op !== "string") continue;
    out.push({
      column: r.column,
      op: r.op as ScopePredicateOp,
      value: r.value,
      values: Array.isArray(r.values) ? r.values : undefined,
    });
  }
  return { predicates: out };
}

function coerceRecipe(
  raw: unknown,
  index: number,
): { recipe: Recipe | null; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!isRecord(raw)) {
    errors.push(`Entry #${index + 1}: not an object, skipped.`);
    return { recipe: null, warnings, errors };
  }
  const obj = raw as Record<string, unknown>;
  const where = obj.id ? `recipe "${obj.id}"` : `entry #${index + 1}`;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) {
    errors.push(`${where}: missing required field \`title\`, skipped.`);
    return { recipe: null, warnings, errors };
  }

  // Kind is required — no silent default. Mirrors the server's hard
  // cutover rule for the recipe schema.
  const kindRaw = obj.kind;
  if (typeof kindRaw !== "string" || !(ALL_KINDS as readonly string[]).includes(kindRaw)) {
    errors.push(
      `${where}: missing or unknown \`kind\` (expected one of: ${ALL_KINDS.join(", ")}). Skipped.`,
    );
    return { recipe: null, warnings, errors };
  }
  const kind = kindRaw as RecipeKind;

  // Reject reserved Example fields for connectivity — `mat_version`
  // and `root` make this an Example, not a Recipe. Explorer recipes
  // don't have an Example analog so we don't check for them.
  if (kind === "connectivity" && (obj.mat_version != null || obj.root != null)) {
    errors.push(
      `${where}: looks like an Example (has mat_version/root), not a Recipe. Skipped.`,
    );
    return { recipe: null, warnings, errors };
  }

  // Mint a fresh personal id; preserve the YAML's id in the description
  // suffix so the user can correlate uploaded entries with their source.
  const sourceId = typeof obj.id === "string" && obj.id ? obj.id : null;
  const description = typeof obj.description === "string" ? obj.description : null;
  const finalDescription = description
    ? sourceId
      ? `${description} (source id: ${sourceId})`
      : description
    : sourceId
      ? `(source id: ${sourceId})`
      : null;

  // Dispatch to the kind-specific adapter for the rest of the
  // coercion. The adapter knows what fields its recipe carries and
  // how to be tolerant about their shapes.
  const adapter = adapterFor(kind);
  const recipe = adapter.fromYaml(obj, {
    id: newPersonalId(),
    title,
    description: finalDescription ?? undefined,
  });
  if (!recipe) {
    errors.push(`${where}: shape doesn't match \`kind: ${kind}\`, skipped.`);
    return { recipe: null, warnings, errors };
  }
  return { recipe, warnings, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
