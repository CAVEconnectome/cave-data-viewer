interface Props {
  /** Currently-focused cell. Rendered as a one-row section at the top so
   *  the user always sees "the cell I'm looking at" prominently. */
  focusCellId: string | null;
  /** kNN result. Empty array means "no neighbors searched yet"; non-empty
   *  renders a scrollable list. */
  neighborCellIds: string[];
  /** Lasso/box-selected cell_ids. Same treatment as neighbors but a
   *  different section header + color cue. */
  brushCellIds: string[];
  /** Called when the user clicks a row — focuses that cell. The actual
   *  cross-nav to /neuron with resolver-translated root_id lands in
   *  task #11; for now clicking a row just sets the focus. */
  onCellClick: (cellId: string) => void;
  /** "Clear" affordances on each section. The caller wipes the
   *  corresponding URL state. */
  onClearNeighbors: () => void;
  onClearBrush: () => void;
}

/**
 * Right-rail summary of the three selection states maintained by the
 * scatter: Focus, kNN Neighbors, and Brush selection. Each section is
 * collapsible empty (no header noise when nothing is selected) and lists
 * its cell_ids one per row.
 *
 * v1 (this task) renders rows as plain buttons that focus the clicked
 * cell. Task #11 swaps these for resolver-prefetched <Link>s into
 * /neuron with the correct root_id, plus "Open in Neuroglancer" bulk
 * actions per section.
 */
export function SelectionPane({
  focusCellId,
  neighborCellIds,
  brushCellIds,
  onCellClick,
  onClearNeighbors,
  onClearBrush,
}: Props) {
  const empty =
    !focusCellId && neighborCellIds.length === 0 && brushCellIds.length === 0;
  if (empty) {
    return (
      <aside className="explore-selection explore-selection-empty">
        Click a point, lasso a region, or use the kNN controls to start a selection.
      </aside>
    );
  }

  return (
    <aside className="explore-selection">
      {focusCellId && (
        <Section title="Focus" color="focus">
          <CellRow cellId={focusCellId} onClick={onCellClick} />
        </Section>
      )}
      {neighborCellIds.length > 0 && (
        <Section
          title={`Neighbors (${neighborCellIds.length})`}
          color="neighbor"
          onClear={onClearNeighbors}
        >
          {neighborCellIds.map((id) => (
            <CellRow key={`nbr-${id}`} cellId={id} onClick={onCellClick} />
          ))}
        </Section>
      )}
      {brushCellIds.length > 0 && (
        <Section
          title={`Brush selection (${brushCellIds.length})`}
          color="brush"
          onClear={onClearBrush}
        >
          {brushCellIds.map((id) => (
            <CellRow key={`brush-${id}`} cellId={id} onClick={onCellClick} />
          ))}
        </Section>
      )}
    </aside>
  );
}

interface SectionProps {
  title: string;
  color: "focus" | "neighbor" | "brush";
  onClear?: () => void;
  children: React.ReactNode;
}

function Section({ title, color, onClear, children }: SectionProps) {
  return (
    <div className={`explore-selection-section explore-selection-${color}`}>
      <header>
        <span className="explore-selection-pip" aria-hidden />
        <span className="explore-selection-title">{title}</span>
        {onClear && (
          <button
            type="button"
            className="explore-selection-clear"
            onClick={onClear}
            aria-label={`Clear ${title.toLowerCase()}`}
          >
            ×
          </button>
        )}
      </header>
      <div className="explore-selection-rows">{children}</div>
    </div>
  );
}

interface CellRowProps {
  cellId: string;
  onClick: (cellId: string) => void;
}

function CellRow({ cellId, onClick }: CellRowProps) {
  return (
    <button
      type="button"
      className="explore-selection-row"
      onClick={() => onClick(cellId)}
      title={`Focus cell ${cellId}`}
    >
      <span className="explore-selection-row-id">{cellId}</span>
    </button>
  );
}
