import { useCallback } from "react";
import { useMakeLinkMutation } from "../api/queries";
import type { ColumnGroup, ConnectivityBundle } from "../api/types";
import { CopyableId, displayName, formatCell } from "./tableColumns";

/**
 * "Cell" tab content — a single-row view of the queried cell with all
 * of its decoration / cell-type / spatial annotations. Sibling to
 * `<PartnersTable>` but intentionally simpler: no sorting, no
 * filtering, no pagination, no row selection. Just "what does CAVE
 * know about this specific cell."
 *
 * Synapse-group columns are dropped — they're per-partner by
 * construction (n_syn_in/out, mean_size, etc.) and don't apply to the
 * cell itself. Everything else from the bundle's `column_groups` is
 * shown in the same left-to-right order the partner tabs use, so a
 * user moving between tabs sees a consistent layout.
 *
 * Action bar surfaces just the "open in Neuroglancer" button — the
 * cross-nav arrow on a partner row makes no sense here (you're already
 * viewing this cell), and the per-direction NGL link templates degrade
 * to "connectivity" (both pre and post layers).
 */

interface Props {
  ds: string;
  rootId: string;
  matVersion: number | "live";
  bundle: ConnectivityBundle;
  columnGroups: ColumnGroup[];
}

function bareColumnName(key: string): string {
  const i = key.indexOf(".");
  return i >= 0 ? key.slice(i + 1) : key;
}

export function CellPanel({ ds, rootId, matVersion, bundle, columnGroups }: Props) {
  const cell = bundle.root_record;
  const makeLink = useMakeLinkMutation();
  const open = useCallback(
    async (template: string) => {
      const result = await makeLink.mutateAsync({
        ds, rootId, matVersion, template,
      });
      window.open(result.url, "_blank");
    },
    [ds, matVersion, makeLink, rootId],
  );

  if (!cell) {
    // Bundle without `root_record` should be impossible once the backend
    // change is deployed — handled gracefully so a stale frontend talking
    // to an old backend doesn't crash.
    return (
      <div className="cell-panel">
        <p className="error">No cell information available.</p>
      </div>
    );
  }

  // Drop the synapse group — its columns are per-edge stats (num_syn,
  // mean_size, median_dist_to_target_soma, ...) that don't apply to a
  // single cell. All other groups (intrinsic, cell_type, soma, table,
  // spatial) come through unchanged in the same order as the partner
  // tabs, so the visual structure matches.
  const groups = columnGroups.filter((g) => g.kind !== "synapse");

  // `partners` class so the existing partner-table CSS applies to the
  // shared header / row styling — keeps the Cell tab visually coherent
  // with the other tabs without duplicating selectors. `cell-panel` is
  // an extension hook for any Cell-specific tweaks we want later.
  return (
    <div className="partners cell-panel">
      <div className="actions">
        <button onClick={() => open("connectivity")}>
          Open this cell in Neuroglancer
        </button>
        {makeLink.isError && (
          <span className="error">{makeLink.error.message}</span>
        )}
      </div>
      <div className="partners-scroll">
        <table>
          <thead>
            <tr className="group-row">
              {groups.map((g) => (
                <th
                  key={g.name}
                  colSpan={g.columns.length}
                  className={`group-header group-${g.kind}`}
                >
                  {g.kind === "intrinsic" ? null : (
                    <span className="group-label" title={g.name}>{g.name}</span>
                  )}
                </th>
              ))}
            </tr>
            <tr>
              {groups.flatMap((g) =>
                g.columns.map((c) => (
                  <th key={c}>{displayName(bareColumnName(c), bundle.spatial_meta.label_overrides)}</th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            <tr>
              {groups.flatMap((g) =>
                g.columns.map((c) => {
                  const v = cell[c];
                  if (c === "root_id" || c === "cell_id") {
                    return (
                      <td key={c}>
                        <CopyableId value={v} />
                      </td>
                    );
                  }
                  return <td key={c}>{formatCell(v)}</td>;
                }),
              )}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
