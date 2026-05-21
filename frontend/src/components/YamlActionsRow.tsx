import { useRef, useState } from "react";

import { save as savePersonal } from "../tours/personalRecipes";
import { parseRecipesFromYaml } from "../tours/recipeFromYaml";

interface Props {
  ds: string;
  /** Download click handler. Caller owns building the recipe + emitting
   *  YAML + triggering the browser download, since the recipe shape
   *  (connectivity vs explorer) is kind-specific. */
  onDownload: () => void;
  downloadDisabled: boolean;
  downloadTitle?: string;
  /** Optional hook for "upload succeeded" side-effects (e.g. flashing
   *  the parent's Save button to signal the recipe was persisted). */
  onUploaded?: (count: number) => void;
}

/**
 * Compact "secondary actions" row for download/upload-YAML. Sits beneath
 * the three primary share buttons in both ShareMenu (connectivity) and
 * ExplorerShareMenu — same component in both so the look stays in sync.
 *
 * Upload logic is identical in both contexts (parse the YAML, save each
 * recipe via the personal-recipes module); only download differs, which
 * is why the caller owns that callback.
 */
export function YamlActionsRow({
  ds,
  onDownload,
  downloadDisabled,
  downloadTitle,
  onUploaded,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadMessage, setUploadMessage] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  const onUploadClick = () => fileInputRef.current?.click();

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseRecipesFromYaml(text);
    for (const recipe of parsed.recipes) savePersonal(ds, recipe);
    e.target.value = "";

    if (parsed.recipes.length > 0) {
      setUploadMessage({
        kind: "ok",
        text: `Loaded ${parsed.recipes.length} recipe${parsed.recipes.length === 1 ? "" : "s"}.`,
      });
      onUploaded?.(parsed.recipes.length);
    } else {
      setUploadMessage({
        kind: "err",
        text: parsed.errors[0] ?? "No recipes found in file.",
      });
    }
    window.setTimeout(() => setUploadMessage(null), 4000);
  };

  return (
    <>
      <div className="sidebar-share-yaml-row">
        <button
          type="button"
          className="sidebar-share-yaml-btn"
          onClick={onDownload}
          disabled={downloadDisabled}
          title={downloadTitle ?? "Download the current view as a YAML recipe"}
        >
          Download YAML
        </button>
        <button
          type="button"
          className="sidebar-share-yaml-btn"
          onClick={onUploadClick}
          title="Load a recipe from a YAML file"
        >
          Upload YAML
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml,application/x-yaml,text/yaml"
          onChange={onFileChosen}
          style={{ display: "none" }}
        />
      </div>
      {uploadMessage && (
        <p className={`sidebar-share-upload-msg ${uploadMessage.kind}`}>
          {uploadMessage.text}
        </p>
      )}
    </>
  );
}
