import { FileTree, useFileTree } from "@pierre/trees/react";
import { useMemo } from "react";
import { usePathIndex } from "../../hooks/usePathIndex.js";
import { TREE_HOST_CSS } from "./treeStyles.js";

interface WorkspaceFileTreeProps {
  paths: string[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}

export function WorkspaceFileTree({ paths, selectedPath, onSelectPath }: WorkspaceFileTreeProps): React.JSX.Element {
  const pathIndexInput = useMemo(() => ({ paths }), [paths]);
  const pathIndex = usePathIndex(pathIndexInput);
  const { model } = useFileTree({
    paths: pathIndex.paths,
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    search: true,
    density: "compact",
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
          <span>Workspace files</span>
          <span>{paths.length}</span>
        </div>
      }
      className="file-tree-host"
      style={{ height: "100%" }}
    />
  );
}
