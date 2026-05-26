import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
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
  const onSelectPathRef = useRef(onSelectPath);
  const suppressSelectionRef = useRef(false);
  const pathsKey = useMemo(() => pathIndex.paths.join("\0"), [pathIndex.paths]);
  const pathSet = useMemo(() => new Set(pathIndex.paths), [pathIndex.paths, pathsKey]);
  const initialSelectedPaths = selectedPath && pathSet.has(selectedPath) ? [selectedPath] : [];
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      files.flatMap<GitStatusEntry>((file) => {
        const status = mapGitStatus(file.status);
        return status ? [{ path: file.path, status }] : [];
      }),
    [files]
  );

  useEffect(() => {
    onSelectPathRef.current = onSelectPath;
  }, [onSelectPath]);

  const { model } = useFileTree({
    paths: pathIndex.paths,
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialSelectedPaths,
    search: true,
    density: "compact",
    gitStatus,
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
    withoutSelectionCallback(suppressSelectionRef, () => model.resetPaths(pathIndex.paths));
  }, [model, pathIndex.paths, pathsKey]);

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
          <span>Changed files</span>
          <span>{files.length}</span>
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
