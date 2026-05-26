import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { useMemo } from "react";
import type { ChangedFile, ChangedFileStatus } from "../../../shared/schemas.js";
import { usePathIndex } from "../../hooks/usePathIndex.js";
import { TREE_HOST_CSS } from "./treeStyles.js";

interface ChangedFileTreeProps {
  files: ChangedFile[];
  selectedPath: string | null;
  openEditorPaths?: string[];
  onSelectPath: (path: string) => void;
}

export function ChangedFileTree({
  files,
  selectedPath,
  openEditorPaths = [],
  onSelectPath
}: ChangedFileTreeProps): React.JSX.Element {
  const pathIndexInput = useMemo(() => ({ changedFiles: files, openEditorPaths }), [files, openEditorPaths]);
  const pathIndex = usePathIndex(pathIndexInput);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      files.flatMap<GitStatusEntry>((file) => {
        const status = mapGitStatus(file.status);
        return status ? [{ path: file.path, status }] : [];
      }),
    [files]
  );
  const { model } = useFileTree({
    paths: pathIndex.paths,
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    search: true,
    density: "compact",
    gitStatus,
    onSelectionChange: (selectedPaths) => {
      const path = selectedPaths[0];
      if (path) {
        onSelectPath(path);
      }
    },
    unsafeCSS: TREE_HOST_CSS
  });

  return (
    <FileTree
      model={model}
      header={
        <div className="tree-header">
          <span>Changed files</span>
          <span>{files.length}</span>
        </div>
      }
      className="file-tree-host"
      style={{ height: "100%" }}
    />
  );
}

function mapGitStatus(status: ChangedFileStatus): GitStatus | null {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "modified":
    case "changed":
      return "modified";
    case "renamed":
    case "copied":
      return "renamed";
    case "unchanged":
      return null;
  }
}
