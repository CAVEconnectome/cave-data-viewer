import { useState } from "react";
import { useEmbeddingKnnMutation } from "../../api/embeddings";
import { useCellIdLookupMutation } from "../../api/queries";
import type { EmbeddingKnnDefaults } from "../../api/types";

interface Props {
  ds: string;
  embeddingId: string;
  matVersion: number | "live";
  /** Manifest-level kNN defaults (default_k + max_k). When absent the
   *  controls fall back to k=25, max=200. */
  knnDefaults?: EmbeddingKnnDefaults;
  /** Current focus cell_id. Reflected back into the input field on the
   *  Cell ID mode so reloading the page restores the input value. */
  currentCellId: string | null;
  /** Current k from `?k=`. Threaded through so the "Find neighbors"
   *  button uses the same k that the URL state will store. */
  currentK: number | null;
  /** Called when the user has identified a cell to focus. Triggered by
   *  "Find cell" (with cell_id input → straight pass, with root_id input
   *  → after a reverse-resolve round-trip). */
  onFocusCell: (cellId: string) => void;
  /** Called with the kNN result: the resolved query cell_id (in case the
   *  user passed a root_id) and the neighbor cell_ids. */
  onNeighbors: (queryCellId: string, neighborCellIds: string[]) => void;
  /** Reflected back into `?k=` if the user edits k. */
  onKChange: (k: number) => void;
}

type IdMode = "cell" | "root";

/**
 * Find-a-cell + find-neighbors controls. Mirrors the cell_search_app
 * sidebar but with two material upgrades:
 *
 *   1. Either id type is accepted — paste a root_id from a Neuroglancer
 *      tab and the server reverse-resolves to a cell_id transparently.
 *   2. k and the feature subset travel through URL state so a shared
 *      link reproduces the same neighbor set.
 *
 * Feature-subset picker is deferred for v1; the manifest's
 * `feature_columns` are always used. Wiring is in place (the kNN
 * mutation takes `featureColumns`) so an "Advanced" gear here later is
 * a small follow-up.
 */
export function KnnControls({
  ds,
  embeddingId,
  matVersion,
  knnDefaults,
  currentCellId,
  currentK,
  onFocusCell,
  onNeighbors,
  onKChange,
}: Props) {
  const defaultK = knnDefaults?.default_k ?? 25;
  const maxK = knnDefaults?.max_k ?? 200;
  const k = currentK ?? defaultK;

  const [idMode, setIdMode] = useState<IdMode>("cell");
  const [idInput, setIdInput] = useState<string>(currentCellId ?? "");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const knn = useEmbeddingKnnMutation();
  const lookup = useCellIdLookupMutation();

  const isWorking = knn.isPending || lookup.isPending;

  // Resolve whatever the user typed into a cell_id and feed it to
  // `onFocusCell`. For cell_id mode this is a no-op; for root_id mode it
  // round-trips through /cell-ids/lookup. Both paths set the focus on
  // success and clear the error on success/failure consistently.
  const resolveToCellId = async (): Promise<string | null> => {
    setErrorMsg(null);
    const raw = idInput.trim();
    if (!raw) {
      setErrorMsg("Enter a cell_id or root_id.");
      return null;
    }
    if (!/^\d+$/.test(raw)) {
      setErrorMsg("Ids must be numeric.");
      return null;
    }
    if (idMode === "cell") return raw;

    // root → cell via the shared lookup endpoint. Single-id batch keeps
    // the round-trip minimal.
    try {
      const result = await lookup.mutateAsync({
        ds, matVersion, rootIds: [raw],
      });
      const cellId = result.root_to_cell[raw];
      if (!cellId) {
        setErrorMsg(`root_id ${raw} has no nucleus mapping at this mat_version.`);
        return null;
      }
      return cellId;
    } catch (e) {
      setErrorMsg(`Lookup failed: ${(e as Error).message}`);
      return null;
    }
  };

  const handleFindCell = async () => {
    const cellId = await resolveToCellId();
    if (cellId) onFocusCell(cellId);
  };

  const handleFindNeighbors = async () => {
    setErrorMsg(null);
    const cellId = await resolveToCellId();
    if (!cellId) return;
    try {
      const result = await knn.mutateAsync({
        ds, embeddingId, cellId, k,
      });
      onFocusCell(result.query_cell_id);
      onNeighbors(
        result.query_cell_id,
        result.neighbors.map((n) => n.cell_id),
      );
    } catch (e) {
      setErrorMsg(`kNN failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="explore-knn">
      <div className="explore-picker-label">Look up a cell</div>

      <div className="explore-knn-mode" role="radiogroup" aria-label="Id type">
        <button
          type="button"
          role="radio"
          aria-checked={idMode === "cell"}
          className={idMode === "cell" ? "active" : ""}
          onClick={() => setIdMode("cell")}
        >
          Cell ID
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={idMode === "root"}
          className={idMode === "root" ? "active" : ""}
          onClick={() => setIdMode("root")}
        >
          Root ID
        </button>
      </div>

      <input
        type="text"
        inputMode="numeric"
        placeholder={idMode === "cell" ? "e.g. 294657" : "e.g. 864691135492749415"}
        className="explore-knn-input"
        value={idInput}
        onChange={(e) => setIdInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isWorking) handleFindCell();
        }}
        disabled={isWorking}
      />

      <div className="explore-knn-k">
        <label htmlFor="explore-knn-k-input">k</label>
        <input
          id="explore-knn-k-input"
          type="number"
          min={1}
          max={maxK}
          value={k}
          onChange={(e) => {
            const next = Math.max(1, Math.min(maxK, Number(e.target.value) || defaultK));
            onKChange(next);
          }}
          disabled={isWorking}
        />
      </div>

      <div className="explore-knn-actions">
        <button
          type="button"
          onClick={handleFindCell}
          disabled={isWorking || !idInput.trim()}
        >
          {lookup.isPending ? "Resolving…" : "Find cell"}
        </button>
        <button
          type="button"
          onClick={handleFindNeighbors}
          disabled={isWorking || !idInput.trim()}
        >
          {knn.isPending ? "Searching…" : `Find ${k} neighbors`}
        </button>
      </div>

      {errorMsg && <div className="explore-knn-error">{errorMsg}</div>}
    </div>
  );
}
