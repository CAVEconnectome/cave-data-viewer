/**
 * Forward-migrate a legacy storage key to a versioned one.
 *
 * The SPA's storage keys are now versioned with a `cdv:v1:` prefix so a
 * future schema change (e.g. switching `collapsed` from a JSON array to
 * a Set serialization) can ship a `cdv:v2:` namespace without silently
 * deserializing old data into the new shape. Idempotent: after the first
 * call, the legacy key is removed and subsequent calls are no-ops.
 *
 * Best-effort — localStorage / sessionStorage can throw in private mode
 * or when the user has denied storage. Migration silently degrades to
 * the no-data path; the caller's own try/catch around the read is the
 * real safety net.
 */
export function migrateStorageKey(
  oldKey: string,
  newKey: string,
  storage: Storage,
): void {
  try {
    const v = storage.getItem(oldKey);
    if (v !== null && storage.getItem(newKey) === null) {
      storage.setItem(newKey, v);
    }
    if (v !== null) {
      storage.removeItem(oldKey);
    }
  } catch {
    // private mode / quota / permission — not our problem.
  }
}
