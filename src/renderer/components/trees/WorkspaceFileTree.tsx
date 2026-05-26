import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { FileTreeInitialExpansion } from "@pierre/trees";
import { usePathIndex } from "../../hooks/usePathIndex.js";
import { TREE_HOST_CSS } from "./treeStyles.js";

interface WorkspaceFileTreeProps {
  paths: string[];
  selectedPath: string | null;
  initialExpansion?: FileTreeInitialExpansion;
  onSelectPath: (path: string) => void;
}

export function WorkspaceFileTree({
  paths,
  selectedPath,
  initialExpansion = "closed",
  onSelectPath
}: WorkspaceFileTreeProps): React.JSX.Element {
  const pathIndexInput = useMemo(() => ({ paths }), [paths]);
  const pathIndex = usePathIndex(pathIndexInput);

  if (pathIndex.isIndexing) {
    return <div className="editor-tree-state">Indexing workspace files.</div>;
  }

  return (
    <WorkspaceFileTreeModel
      paths={pathIndex.paths}
      selectedPath={selectedPath}
      initialExpansion={initialExpansion}
      onSelectPath={onSelectPath}
      sourceCount={paths.length}
    />
  );
}

interface WorkspaceFileTreeModelProps {
  paths: string[];
  selectedPath: string | null;
  initialExpansion: FileTreeInitialExpansion;
  onSelectPath: (path: string) => void;
  sourceCount: number;
}

function WorkspaceFileTreeModel({
  paths,
  selectedPath,
  initialExpansion,
  onSelectPath,
  sourceCount
}: WorkspaceFileTreeModelProps): React.JSX.Element {
  const onSelectPathRef = useRef(onSelectPath);
  const suppressSelectionRef = useRef(false);
  const pathsKey = useMemo(() => paths.join("\0"), [paths]);
  const pathSet = useMemo(() => new Set(paths), [pathsKey, paths]);
  const initialSelectedPaths = selectedPath && pathSet.has(selectedPath) ? [selectedPath] : [];

  useEffect(() => {
    onSelectPathRef.current = onSelectPath;
  }, [onSelectPath]);

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,
    initialExpansion,
    initialSelectedPaths,
    search: true,
    density: "compact",
    onSelectionChange: (selectedPaths) => {
      if (suppressSelectionRef.current) {
        return;
      }
      const path = selectedPaths[0];
      if (path) {
        onSelectPathRef.current(path);
      }
    },
    unsafeCSS: TREE_HOST_CSS
  });

  useEffect(() => {
    withoutSelectionCallback(suppressSelectionRef, () => model.resetPaths(paths));
  }, [model, paths, pathsKey]);

  useEffect(() => {
    withoutSelectionCallback(suppressSelectionRef, () => {
      if (!selectedPath || !pathSet.has(selectedPath)) {
        for (const path of model.getSelectedPaths()) {
          model.getItem(path)?.deselect();
        }
        return;
      }
      const currentSelection = model.getSelectedPaths();
      if (currentSelection.length === 1 && currentSelection[0] === selectedPath) {
        return;
      }
      for (const path of currentSelection) {
        if (path !== selectedPath) {
          model.getItem(path)?.deselect();
        }
      }
      model.getItem(selectedPath)?.select();
    });
  }, [model, pathSet, selectedPath]);

  return (
    <FileTree
      model={model}
      header={
        <div className="tree-header">
          <span>Workspace files</span>
          <span>{sourceCount}</span>
        </div>
      }
      className="file-tree-host"
      style={{ height: "100%" }}
    />
  );
}

function withoutSelectionCallback(suppressSelectionRef: MutableRefObject<boolean>, callback: () => void): void {
  suppressSelectionRef.current = true;
  try {
    callback();
  } finally {
    suppressSelectionRef.current = false;
  }
}
