import { useEmbeddingList } from "../../api/embeddings";
import { useUrlParam } from "../../hooks/useUrlState";

/**
 * Route component for `/explore`.
 *
 * Currently a placeholder during the refactor onto the shared toolkit
 * (AnalyticsRail + PartnersTable mold + CellFilterPanel). The catalog
 * fetch is kept live so we can confirm the manifest pipeline still
 * resolves while the UI is being rewritten.
 */
export function FeatureExplorer() {
  const [ds] = useUrlParam("ds");
  const catalog = useEmbeddingList(ds);

  return (
    <div className="explore-empty">
      <h2>Feature Explorer</h2>
      <p>
        UI is being rebuilt onto the shared toolkit (AnalyticsRail,
        PartnersTable, CellFilterPanel). Backend foundation
        (manifest discovery, parquet cache, kNN, resolver) is intact.
      </p>
      {catalog.data?.enabled && (
        <p style={{ marginTop: 8 }}>
          Catalog reachable for <code>{ds}</code> —{" "}
          {catalog.data.feature_tables?.length ?? 0} feature table(s)
          {" "}/{" "}
          {(catalog.data.feature_tables ?? []).reduce(
            (n, ft) => n + (ft.embeddings?.length ?? 0),
            0,
          )}{" "}embedding(s) discovered.
        </p>
      )}
    </div>
  );
}
