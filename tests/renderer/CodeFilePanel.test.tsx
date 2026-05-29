import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeFilePanel } from "../../src/renderer/components/diffs/DiffPanel.js";
import type { PullRequestDetail, RepositoryRef } from "../../src/shared/schemas.js";

const diffMockState = vi.hoisted(() => ({
  fileProps: [] as Array<{
    file: { contents: string; name: string };
    selectedLines?: unknown;
    options?: { onPostRender?: (node: HTMLElement) => void };
  }>,
  scrollIntoView: vi.fn()
}));

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  return {
    File: (props: {
      file: { contents: string; name: string };
      selectedLines?: unknown;
      options?: { onPostRender?: (node: HTMLElement) => void };
    }) => {
      diffMockState.fileProps.push(props);
      const host = document.createElement("div");
      const shadow = host.attachShadow({ mode: "open" });
      const lineCount = props.file.contents.split(/\r\n|\r|\n/).length;
      for (let lineNumber = 1; lineNumber <= Math.max(lineCount, 42); lineNumber += 1) {
        const line = document.createElement("div");
        line.dataset.line = String(lineNumber);
        line.scrollIntoView = diffMockState.scrollIntoView as Element["scrollIntoView"];
        shadow.append(line);
      }
      props.options?.onPostRender?.(host);
      return React.createElement("div", { "data-testid": "file-view" }, props.file.name);
    },
    FileDiff: () => React.createElement("div", { "data-testid": "full-context-diff-view" }),
    PatchDiff: () => React.createElement("div", { "data-testid": "patch-view" }),
    useWorkerPool: () => undefined
  };
});

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const pullRequest: PullRequestDetail = {
  provider: "github",
  id: "pr-12",
  number: 12,
  repository,
  title: "Definition target",
  state: "open",
  draft: false,
  url: "https://github.com/kol/repo/pull/12",
  author: { login: "kol" },
  labels: [],
  reviewers: [],
  baseRef: "main",
  headRef: "feature",
  headSha: "abc123",
  baseSha: "base123",
  additions: 1,
  deletions: 0,
  changedFileCount: 1,
  commentCount: 0,
  updatedAt: "2026-05-27T00:00:00.000Z",
  createdAt: "2026-05-27T00:00:00.000Z",
  body: "",
  isFromFork: false
};

const originalFileContent = window.krt.pullRequests.fileContent;
const originalRequestAnimationFrame = window.requestAnimationFrame;

afterEach(() => {
  window.krt.pullRequests.fileContent = originalFileContent;
  window.requestAnimationFrame = originalRequestAnimationFrame;
  diffMockState.fileProps.length = 0;
  diffMockState.scrollIntoView.mockReset();
});

describe("CodeFilePanel definition navigation", () => {
  it("selects and scrolls to the requested target line", async () => {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.krt.pullRequests.fileContent = async () => ({
      provider: "github",
      repository,
      path: "src/main.rs",
      ref: "abc123",
      contents: "fn main() {}\n",
      encoding: "utf-8",
      isLarge: false
    });

    renderWithQuery(
      <CodeFilePanel
        pullRequest={pullRequest}
        path="src/main.rs"
        targetLine={42}
        navigationKey={7}
      />
    );

    expect(await screen.findByTestId("file-view")).toHaveTextContent("src/main.rs");
    await waitFor(() => {
      expect(diffMockState.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "auto" });
    });
    expect(diffMockState.fileProps.at(-1)?.selectedLines).toEqual({ start: 42, end: 42 });
  });

  it("opens an in-file find bar with Cmd+F and navigates matches", async () => {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.krt.pullRequests.fileContent = async () => ({
      provider: "github",
      repository,
      path: "src/main.rs",
      ref: "abc123",
      contents: "fn main() {}\nlet needle = 1;\nlet other_needle = 2;\n",
      encoding: "utf-8",
      isLarge: false
    });

    renderWithQuery(<CodeFilePanel pullRequest={pullRequest} path="src/main.rs" />);

    expect(await screen.findByTestId("file-view")).toHaveTextContent("src/main.rs");
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in file" });
    fireEvent.change(input, { target: { value: "needle" } });

    await waitFor(() => {
      expect(screen.getByText("1/2")).toBeInTheDocument();
      expect(diffMockState.fileProps.at(-1)?.selectedLines).toEqual({ start: 2, end: 2 });
    });

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("2/2")).toBeInTheDocument();
      expect(diffMockState.fileProps.at(-1)?.selectedLines).toEqual({ start: 3, end: 3 });
    });
  });
});

function renderWithQuery(element: React.ReactElement): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}
