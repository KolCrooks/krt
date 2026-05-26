import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangedFileTree } from "../../src/renderer/components/trees/ChangedFileTree.js";
import type { ChangedFile } from "../../src/shared/schemas.js";

const treeMockState = vi.hoisted(() => {
  const state: {
    initialized: boolean;
    selectedPaths: string[];
    options: { initialSelectedPaths?: string[]; onSelectionChange?: (paths: string[]) => void } | null;
    resetPaths: ReturnType<typeof vi.fn>;
    getItem: ReturnType<typeof vi.fn>;
    selectCalls: string[];
    deselectCalls: string[];
  } = {
    initialized: false,
    selectedPaths: [],
    options: null,
    resetPaths: vi.fn(),
    getItem: vi.fn(),
    selectCalls: [],
    deselectCalls: []
  };
  state.getItem.mockImplementation((path: string) => ({
    select: () => {
      state.selectCalls.push(path);
      state.selectedPaths = Array.from(new Set([...state.selectedPaths, path]));
      state.options?.onSelectionChange?.([path]);
    },
    deselect: () => {
      state.deselectCalls.push(path);
      state.selectedPaths = state.selectedPaths.filter((candidate) => candidate !== path);
      state.options?.onSelectionChange?.(state.selectedPaths);
    }
  }));
  return state;
});

vi.mock("@pierre/trees/react", async () => {
  const React = await import("react");
  return {
    FileTree: () => React.createElement("div", { "data-testid": "changed-file-tree" }),
    useFileTree: (options: { initialSelectedPaths?: string[]; onSelectionChange?: (paths: string[]) => void }) => {
      treeMockState.options = options;
      if (!treeMockState.initialized) {
        treeMockState.selectedPaths = [...(options.initialSelectedPaths ?? [])];
        treeMockState.initialized = true;
      }
      return {
        model: {
          resetPaths: treeMockState.resetPaths,
          getSelectedPaths: () => treeMockState.selectedPaths,
          getItem: treeMockState.getItem
        }
      };
    }
  };
});

afterEach(() => {
  treeMockState.initialized = false;
  treeMockState.selectedPaths = [];
  treeMockState.options = null;
  treeMockState.resetPaths.mockClear();
  treeMockState.getItem.mockClear();
  treeMockState.selectCalls = [];
  treeMockState.deselectCalls = [];
});

describe("ChangedFileTree", () => {
  it("syncs external selected path changes into the tree selection", () => {
    const files = [changedFile("src/one.rs"), changedFile("src/two.rs")];
    const onSelectPath = vi.fn();
    const { rerender } = render(
      <ChangedFileTree files={files} selectedPath="src/one.rs" onSelectPath={onSelectPath} />
    );

    expect(treeMockState.selectedPaths).toEqual(["src/one.rs"]);

    rerender(<ChangedFileTree files={files} selectedPath="src/two.rs" onSelectPath={onSelectPath} />);

    expect(treeMockState.deselectCalls).toContain("src/one.rs");
    expect(treeMockState.selectCalls).toContain("src/two.rs");
    expect(treeMockState.selectedPaths).toEqual(["src/two.rs"]);
    expect(onSelectPath).not.toHaveBeenCalled();
  });
});

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 0
  };
}
