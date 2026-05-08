/**
 * Browser-local personal recipes with optional server-side persistence.
 *
 * localStorage is the source of truth for "what the user sees right now"
 * — the synchronous `listForDs` API renders the sidebar and landing page
 * during the same React tick as the rest of the UI, with no loading
 * state. When `/api/v1/me/recipes/config` reports the server-side store
 * is enabled, this module also write-throughs to GCS via the
 * `/api/v1/me/recipes/...` endpoints, so recipes follow the user across
 * browsers and machines.
 *
 * Storage shape (single key `cdv:v1:recipes`):
 *
 *     { version: 1, byDs: { "<datastack>": [Recipe, ...] } }
 *
 * Server sync state machine:
 *
 *     pending   → on module load. save/remove queue server ops.
 *     enabled   → /me/recipes/config returned enabled:true. save/remove
 *                 fire server ops directly; failures requeue.
 *     disabled  → config returned enabled:false (dev_bypass / no_bucket)
 *                 or the probe failed. save/remove are localStorage-only.
 *
 * Mutations dispatch a `cdv:personal-recipes-changed` window event so
 * sibling components (the SidebarRecipes widget, LandingPage) re-read
 * without a shared state store. The `storage` event from other tabs
 * also re-dispatches this event so cross-tab updates are immediate.
 *
 * Migration safety: the `cdv:v1:userdata_migrated:<ds>` flag prevents
 * "I deleted everything on another machine, then came back here where
 * local still has them, and they got re-uploaded." Once set (after a
 * successful first reconcile), an empty server list NEVER triggers an
 * upload of stale local state — the server is authoritative.
 */
import { dump as yamlDump, JSON_SCHEMA, load as yamlLoad } from "js-yaml";
import type { Recipe } from "../api/types";
import { migrateStorageKey } from "../hooks/storageMigration";

const STORAGE_KEY = "cdv:v1:recipes";
const CHANGE_EVENT = "cdv:personal-recipes-changed";
const MIG_KEY_PREFIX = "cdv:v1:userdata_migrated:";

// One-shot forward-migration from the unversioned legacy key. Runs at
// module load (idempotent) so the `readAll` call below sees v1 data even
// on a user's first session after the version bump.
migrateStorageKey("cdv:recipes", STORAGE_KEY, localStorage);

interface StoredRecipes {
  version: 1;
  byDs: Record<string, Recipe[]>;
}

const EMPTY: StoredRecipes = { version: 1, byDs: {} };

function readAll(): StoredRecipes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, byDs: {} };
    const obj = JSON.parse(raw) as Partial<StoredRecipes>;
    if (obj && typeof obj === "object" && obj.version === 1 && obj.byDs && typeof obj.byDs === "object") {
      return { version: 1, byDs: obj.byDs as Record<string, Recipe[]> };
    }
    return { version: 1, byDs: {} };
  } catch {
    // Quota exceeded, private mode, malformed JSON — treat as empty.
    return { version: 1, byDs: {} };
  }
}

function writeAll(data: StoredRecipes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // Silently degrade — we don't have a UX-affordance for storage
    // failures and they're rare. Caller's optimistic UI update will
    // simply not be reflected on next mount.
  }
}

export function listForDs(ds: string): Recipe[] {
  return readAll().byDs[ds] ?? [];
}

export function save(ds: string, recipe: Recipe): void {
  const all = readAll();
  const list = all.byDs[ds] ?? [];
  // De-dupe by id — `save` doubles as upsert. Personal recipe ids are
  // generated to be unique, but defensive against an odd retry flow.
  const next = [...list.filter((r) => r.id !== recipe.id), recipe];
  writeAll({ version: 1, byDs: { ...all.byDs, [ds]: next } });
  scheduleServerPut(ds, recipe);
}

export function remove(ds: string, id: string): void {
  const all = readAll();
  const list = all.byDs[ds] ?? [];
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) {
    // Nothing to remove locally — also skip the server call. Avoids a
    // spurious DELETE for ids the user never had.
    return;
  }
  writeAll({ version: 1, byDs: { ...all.byDs, [ds]: next } });
  scheduleServerDelete(ds, id);
}

export function exists(ds: string, id: string): boolean {
  return listForDs(ds).some((r) => r.id === id);
}

/** Generate a fresh personal-recipe id. The `personal-` prefix lets the
 *  merged sidebar list discriminate operator vs personal recipes without a
 *  separate flag, and guarantees no collision with operator ids (which
 *  come from YAML keys and never start with `personal-`). The shape also
 *  matches the backend's `_RECIPE_ID_PATTERN` regex (`^personal-[a-z0-9-]{4,64}$`). */
export function newPersonalId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `personal-${ts}-${rnd}`;
}

export function isPersonalId(id: string): boolean {
  return id.startsWith("personal-");
}

/** Subscribe to mutation events. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

// Re-export the empty constant for callers that want a stable reference.
export const EMPTY_STORE: Readonly<StoredRecipes> = EMPTY;

// ---------- Server sync ---------------------------------------------------

type ServerMode = "pending" | "enabled" | "disabled";
let _serverMode: ServerMode = "pending";

interface ServerConfig {
  enabled: boolean;
  reason?: "dev_bypass" | "no_bucket";
  /** Server's preferred body-schema version. Today always 1. The SPA
   *  reads this so a future v2 server can advertise its preferred shape
   *  to a v1 client without an endpoint-version bump. */
  schema_version?: number;
  /** Versions the server can read AND write on PUT. The SPA may refuse
   *  to send a body version not in this set (today: just [1]). */
  supported_schema_versions?: number[];
}

/** Body-schema version this client emits on PUT. Server stamps it if we
 *  forget; we stamp it explicitly so every PUT carries an unambiguous
 *  version and a future server can honor it without inferring. Bump only
 *  when the SPA's Recipe shape actually changes. */
const CLIENT_SCHEMA_VERSION = 1;

type RetryOp =
  | { type: "put"; ds: string; recipeId: string; body: string }
  | { type: "delete"; ds: string; recipeId: string };

// Server ops queued during "pending" or after a transient failure.
// Drained on bootstrap-completion and on window focus.
const _retryQueue: RetryOp[] = [];

/** Internal status read for tests / future "synced" indicator. */
export function _serverSyncMode(): ServerMode {
  return _serverMode;
}

function recipeToYamlBody(recipe: Recipe): string {
  // Flat document at root — js-yaml's dump emits a Recipe object as a
  // YAML mapping that matches what the server's PyYAML safe_dump
  // produces. sortKeys: false preserves insertion order so id/title
  // lead the document for `gsutil cat` readability. JSON_SCHEMA keeps
  // the parser/emitter restricted to JSON-compatible YAML — no anchors,
  // no custom tags.
  //
  // Stamp `version` if the recipe doesn't already carry one. Server
  // would default it to CURRENT_SCHEMA_VERSION anyway, but stamping
  // here means every byte we send is unambiguous and a future
  // multi-version server doesn't have to infer.
  const versioned: Recipe =
    recipe.version === undefined
      ? { ...recipe, version: CLIENT_SCHEMA_VERSION }
      : recipe;
  return yamlDump(versioned, { schema: JSON_SCHEMA, sortKeys: false });
}

function scheduleServerPut(ds: string, recipe: Recipe): void {
  if (_serverMode === "disabled") return;
  const body = recipeToYamlBody(recipe);
  if (_serverMode === "pending") {
    _retryQueue.push({ type: "put", ds, recipeId: recipe.id, body });
    return;
  }
  // enabled — fire and re-queue on failure.
  void putRecipeToServer(ds, recipe.id, body);
}

function scheduleServerDelete(ds: string, id: string): void {
  if (_serverMode === "disabled") return;
  if (_serverMode === "pending") {
    _retryQueue.push({ type: "delete", ds, recipeId: id });
    return;
  }
  void deleteRecipeOnServer(ds, id);
}

async function putRecipeToServer(ds: string, id: string, body: string): Promise<void> {
  try {
    const resp = await fetch(`/api/v1/me/recipes/${encodeURIComponent(ds)}/${encodeURIComponent(id)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/yaml" },
      body,
    });
    if (!resp.ok) {
      // 4xx errors (e.g., 413 size cap, 400 invalid) are not retryable —
      // requeueing would loop forever. Log loudly and drop.
      if (resp.status >= 400 && resp.status < 500) {
        console.warn(`[recipes] server PUT rejected (${resp.status}); not retrying`);
        return;
      }
      throw new Error(`PUT ${resp.status}`);
    }
  } catch (err) {
    console.warn("[recipes] server PUT failed; queued for retry", err);
    _retryQueue.push({ type: "put", ds, recipeId: id, body });
  }
}

async function deleteRecipeOnServer(ds: string, id: string): Promise<void> {
  try {
    const resp = await fetch(`/api/v1/me/recipes/${encodeURIComponent(ds)}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!resp.ok) {
      if (resp.status >= 400 && resp.status < 500) {
        console.warn(`[recipes] server DELETE rejected (${resp.status}); not retrying`);
        return;
      }
      throw new Error(`DELETE ${resp.status}`);
    }
  } catch (err) {
    console.warn("[recipes] server DELETE failed; queued for retry", err);
    _retryQueue.push({ type: "delete", ds, recipeId: id });
  }
}

async function fetchServerConfig(): Promise<ServerConfig> {
  const resp = await fetch("/api/v1/me/recipes/config", { credentials: "include" });
  if (!resp.ok) throw new Error(`config ${resp.status}`);
  return (await resp.json()) as ServerConfig;
}

async function fetchServerList(ds: string): Promise<Recipe[]> {
  const resp = await fetch(`/api/v1/me/recipes/${encodeURIComponent(ds)}`, {
    credentials: "include",
    headers: { Accept: "application/yaml" },
  });
  if (!resp.ok) throw new Error(`list ${resp.status}`);
  const text = await resp.text();
  // Empty body is a valid "no recipes" — yamlLoad('') returns undefined.
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = yamlLoad(text, { schema: JSON_SCHEMA });
  } catch (err) {
    console.warn("[recipes] failed to parse server list YAML", err);
    return [];
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { recipes?: unknown }).recipes)
  ) {
    // Trust the server-side shape — we own both ends.
    return (parsed as { recipes: Recipe[] }).recipes;
  }
  return [];
}

async function flushRetryQueue(): Promise<void> {
  if (_serverMode !== "enabled" || _retryQueue.length === 0) return;
  // Drain to a local snapshot so concurrent enqueues during the flush
  // don't make this loop forever; the next focus event picks them up.
  const ops = _retryQueue.splice(0, _retryQueue.length);
  for (const op of ops) {
    if (op.type === "put") {
      await putRecipeToServer(op.ds, op.recipeId, op.body);
    } else {
      await deleteRecipeOnServer(op.ds, op.recipeId);
    }
  }
}

// Server is the migration boundary. SPA sends what it has (stamped with
// CLIENT_SCHEMA_VERSION); server validates against SUPPORTED_SCHEMA_VERSIONS
// and stores. On read, the SPA receives whatever shape the server returned
// — js-yaml load preserves all fields, so a newer server's extra fields
// survive the round-trip through localStorage and back to GCS as long as
// no UI path constructs a fresh Recipe object from individual fields and
// re-saves it (today, recipes are created from current-overlay state, not
// edited; an "edit existing recipe" UI would need to preserve unknowns
// explicitly).
async function reconcileDs(ds: string): Promise<void> {
  let serverList: Recipe[];
  try {
    serverList = await fetchServerList(ds);
  } catch (err) {
    console.warn(`[recipes] reconcile ${ds} failed`, err);
    return;
  }

  const all = readAll();
  const localList = all.byDs[ds] ?? [];
  const migKey = `${MIG_KEY_PREFIX}${ds}`;
  const migrated = localStorage.getItem(migKey) === "1";

  if (serverList.length === 0 && localList.length > 0 && !migrated) {
    // First-server-visit migration: push local up. Once any server
    // recipe exists OR the migrated flag is set, an empty server list
    // means "user deleted everything on another machine" — never
    // re-upload from local.
    await Promise.allSettled(
      localList.map((r) => putRecipeToServer(ds, r.id, recipeToYamlBody(r))),
    );
    localStorage.setItem(migKey, "1");
    try {
      serverList = await fetchServerList(ds);
    } catch {
      // Stale serverList; the next reconcile will catch up.
    }
  } else if (!migrated) {
    // Server has data already — mark migrated so subsequent reconciles
    // don't re-upload after a server-side delete-everything.
    localStorage.setItem(migKey, "1");
  }

  // Server is authoritative. Replace local with server contents.
  writeAll({ version: 1, byDs: { ...readAll().byDs, [ds]: serverList } });
}

async function bootstrapServerSync(): Promise<void> {
  let cfg: ServerConfig;
  try {
    cfg = await fetchServerConfig();
  } catch (err) {
    console.warn("[recipes] config probe failed; localStorage-only mode", err);
    _serverMode = "disabled";
    return;
  }
  if (!cfg.enabled) {
    _serverMode = "disabled";
    return;
  }
  _serverMode = "enabled";

  // Flush any saves that landed during "pending" BEFORE reconcile so
  // the subsequent GET sees the post-flush server state and doesn't
  // overwrite freshly-saved-but-unsynced recipes in the user's local
  // view.
  await flushRetryQueue();

  // Reconcile every known datastack + the active one from the URL.
  const all = readAll();
  const known = new Set(Object.keys(all.byDs));
  for (const ds of known) {
    await reconcileDs(ds);
  }
  try {
    const url = new URL(window.location.href);
    const activeDs = url.searchParams.get("ds");
    if (activeDs && !known.has(activeDs)) {
      await reconcileDs(activeDs);
    }
  } catch {
    // window.location parsing failure is ignorable here.
  }
}

// ---------- Cross-tab + retry triggers ------------------------------------

if (typeof window !== "undefined") {
  // Cross-tab: when another tab writes recipes to localStorage, this tab's
  // sidebar/landing should re-render. The `storage` event only fires in
  // OTHER tabs (not the one that wrote), so this is a free way to keep
  // multi-tab in sync without polling.
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    }
  });
  // Retry queue flush on tab focus — cheap recovery from transient
  // network failures during a save/remove. Also covers the case where
  // the server was down at module load and came back later.
  window.addEventListener("focus", () => {
    void flushRetryQueue();
  });
  // Kick off async server sync. Don't await — module exports must stay
  // synchronous so consumers can render from localStorage immediately.
  void bootstrapServerSync();
}
