import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, GitBranch, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { krtClient } from "../api/client.js";
import { CodeFilePanel } from "./diffs/DiffPanel.js";
import { FinishReviewPopover } from "./FinishReviewPopover.js";
import { CheckoutBanner } from "./review/CheckoutBanner.js";
import { ChangedFileTree } from "./trees/ChangedFileTree.js";
import { WorkspaceFileTree } from "./trees/WorkspaceFileTree.js";
import { WorkspaceTabBar } from "./WorkspaceTabBar.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

interface EditorWorkspaceProps {
  tab: PrTab;
}

export function EditorWorkspace({ tab }: EditorWorkspaceProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const selectFile = useUiStore((state) => state.selectFile);
  const openFileInTab = useUiStore((state) => state.openFileInTab);
  const setFinishOpen = useUiStore((state) => state.setFinishOpen);
  const [textSearchQuery, setTextSearchQuery] = useState("");
  const detail = tab.bundle.detail;
  const workspaceTree = useQuery({
    queryKey: ["workspace-tree", tab.repository, detail.headSha],
    enabled: tab.mode === "managed",
    queryFn: () =>
      krtClient.trees.loadWorkspaceTree({
        repository: detail.repository,
        headSha: detail.headSha
      })
  });
  const managedPaths = workspaceTree.data?.paths ?? [];
  const lspSession = useQuery({
    queryKey: ["lsp-session", tab.repository, detail.headSha],
    enabled: tab.mode === "managed",
    queryFn: () =>
      krtClient.lsp.getSession({
        repository: detail.repository,
        headSha: detail.headSha
      })
  });
  const startLsp = useMutation({
    mutationFn: () =>
      krtClient.lsp.startForWorktree({
        repository: detail.repository,
        headSha: detail.headSha
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["lsp-session", tab.repository, detail.headSha] });
      await queryClient.invalidateQueries({ queryKey: ["lsp-diagnostics", tab.repository, detail.headSha] });
      await queryClient.invalidateQueries({ queryKey: ["lsp-symbols", tab.repository, detail.headSha] });
    }
  });
  const diagnostics = useQuery({
    queryKey: ["lsp-diagnostics", tab.repository, detail.headSha, tab.selectedFilePath],
    enabled: tab.mode === "managed" && Boolean(tab.selectedFilePath),
    queryFn: () =>
      krtClient.lsp.getDiagnostics({
        repository: detail.repository,
        headSha: detail.headSha,
        path: tab.selectedFilePath ?? undefined
      })
  });
  const symbols = useQuery({
    queryKey: ["lsp-symbols", tab.repository, detail.headSha, tab.selectedFilePath],
    enabled: tab.mode === "managed" && Boolean(tab.selectedFilePath),
    queryFn: () =>
      krtClient.lsp.getDocumentSymbols({
        repository: detail.repository,
        headSha: detail.headSha,
        path: tab.selectedFilePath ?? ""
      })
  });
  const definition = useMutation({
    mutationFn: (position: { line: number; character: number }) =>
      krtClient.lsp.getDefinition({
        repository: detail.repository,
        headSha: detail.headSha,
        path: tab.selectedFilePath ?? "",
        position
      })
  });
  const trimmedTextSearchQuery = textSearchQuery.trim();
  const textSearch = useQuery({
    queryKey: ["workspace-text-search", tab.repository, detail.headSha, trimmedTextSearchQuery],
    enabled: tab.mode === "managed" && trimmedTextSearchQuery.length >= 2,
    queryFn: () =>
      krtClient.trees.searchWorkspaceText({
        repository: detail.repository,
        headSha: detail.headSha,
        query: trimmedTextSearchQuery,
        maxResults: 20
      })
  });

  useEffect(() => {
    if (tab.mode !== "managed") {
      return undefined;
    }
    return krtClient.repos.onWorkspaceFileChange((change) => {
      if (
        change.headSha !== detail.headSha ||
        change.repository.provider !== detail.repository.provider ||
        change.repository.fullName !== detail.repository.fullName
      ) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["workspace-tree", tab.repository, detail.headSha] });
      void queryClient.invalidateQueries({ queryKey: ["workspace-text-search", tab.repository, detail.headSha] });
      void queryClient.invalidateQueries({ queryKey: ["lsp-diagnostics", tab.repository, detail.headSha] });
      void queryClient.invalidateQueries({ queryKey: ["lsp-symbols", tab.repository, detail.headSha] });
      if (!change.path || change.path === tab.selectedFilePath) {
        void queryClient.invalidateQueries({ queryKey: ["file-content", tab.repository, detail.headSha] });
      }
    });
  }, [detail.headSha, detail.repository.fullName, detail.repository.provider, queryClient, tab.mode, tab.repository, tab.selectedFilePath]);

  const inThisPrPaths = tab.bundle.changedFiles.map((file) => file.path);
  const fileIsInPr = tab.selectedFilePath ? inThisPrPaths.includes(tab.selectedFilePath) : false;
  const lspReady = tab.mode === "managed" && lspSession.data?.status === "ready";

  return (
    <main className="view editor-workspace">
      <CheckoutBanner tab={tab} />
      <WorkspaceTabBar tab={tab} mode="editor" onFinishReview={() => setFinishOpen(tab.key, true)} />
      <div className="editor-body">
        <aside className="workspace-sidebar">
          {tab.mode === "managed" && managedPaths.length > 0 ? (
            <WorkspaceFileTree paths={managedPaths} selectedPath={tab.selectedFilePath} onSelectPath={(path) => openFileInTab(tab.key, path)} />
          ) : (
            <ChangedFileTree
              files={tab.bundle.changedFiles}
              selectedPath={tab.selectedFilePath}
              openEditorPaths={tab.openFilePaths}
              onSelectPath={(path) => openFileInTab(tab.key, path)}
            />
          )}
        </aside>
        <section className="editor-pane">
          {tab.selectedFilePath ? (
            <div className="editor-breadcrumb" aria-label="File path">
              {breadcrumb(tab.selectedFilePath)}
              <span className="editor-breadcrumb-spacer" />
              <span className="mono editor-breadcrumb-cursor">Ln 1, Col 1</span>
            </div>
          ) : null}
          <CodeFilePanel pullRequest={detail} path={tab.selectedFilePath} />
        </section>
          <aside className="editor-context" aria-label="File context">
            <section className="editor-context-section">
              <h3 className="editor-context-heading">
                <span className="editor-context-eyebrow">In this PR</span>
              </h3>
              {tab.selectedFilePath ? (
                <p>
                  {fileIsInPr ? (
                    <>
                      This file is <strong>{tab.bundle.changedFiles.find((file) => file.path === tab.selectedFilePath)?.status ?? "modified"}</strong> in PR #{tab.number}.
                    </>
                  ) : (
                    <>This file is not part of the PR diff.</>
                  )}
                </p>
              ) : (
                <p className="muted">Select a file to see PR context.</p>
              )}
            </section>
            <section className="editor-context-section">
              <h3 className="editor-context-heading">
                <span className="editor-context-eyebrow">Outline</span>
                {tab.mode !== "managed" ? <span className="editor-context-hint">checkout required</span> : null}
              </h3>
              {(symbols.data ?? []).length === 0 ? <span className="muted">No symbols</span> : null}
              {(symbols.data ?? []).map((symbol) => (
                <button
                  className="symbol-row"
                  type="button"
                  key={`${symbol.name}-${symbol.range.start.line}-${symbol.range.start.character}`}
                  onClick={() => definition.mutate(symbol.selectionRange.start)}
                >
                  <strong>{symbol.name}</strong>
                  <span>{symbol.kind}</span>
                </button>
              ))}
              {definition.data ? (
                <div className="definition-result">
                  Definition: {definition.data.path}:{definition.data.range.start.line + 1}
                </div>
              ) : null}
            </section>
            <section className="editor-context-section">
              <h3 className="editor-context-heading">
                <span className="editor-context-eyebrow">Search</span>
              </h3>
              <label className="workspace-search">
                <div className="input-with-icon">
                  <Search size={13} aria-hidden="true" />
                  <input
                    aria-label="Workspace text search"
                    disabled={tab.mode !== "managed"}
                    placeholder={tab.mode === "managed" ? "Search files" : "Checkout required"}
                    value={textSearchQuery}
                    onChange={(event) => setTextSearchQuery(event.target.value)}
                  />
                </div>
              </label>
              {tab.mode === "managed" && trimmedTextSearchQuery.length > 0 && trimmedTextSearchQuery.length < 2 ? (
                <span className="muted">Enter 2 or more characters</span>
              ) : null}
              {textSearch.isLoading ? <span className="muted">Searching workspace</span> : null}
              {textSearch.data ? (
                <div className="text-search-summary">
                  {textSearch.data.results.length} results across {textSearch.data.searchedFiles} files
                  {textSearch.data.truncated ? " - truncated" : ""}
                </div>
              ) : null}
              <div className="text-search-results">
                {(textSearch.data?.results ?? []).map((result) => (
                  <button className="text-search-row" type="button" key={result.path} onClick={() => openFileInTab(tab.key, result.path)}>
                    <strong>{result.path}</strong>
                    {result.matches.map((match) => (
                      <span key={`${result.path}-${match.lineNumber}`}>
                        {match.lineNumber}: {match.lineText}
                      </span>
                    ))}
                  </button>
                ))}
              </div>
            </section>
            <section className="editor-context-section">
              <h3 className="editor-context-heading">
                <span className="editor-context-eyebrow">Diagnostics</span>
                {(diagnostics.data ?? []).length > 0 ? <span className="editor-context-hint">{(diagnostics.data ?? []).length}</span> : null}
              </h3>
              {(diagnostics.data ?? []).length === 0 ? <span className="muted">No diagnostics</span> : null}
              {(diagnostics.data ?? []).map((diagnostic) => (
                <div className={`diagnostic-row diagnostic-${diagnostic.severity}`} key={diagnostic.id}>
                  <strong>{diagnostic.severity}</strong>
                  <span>{diagnostic.message}</span>
                  <small>
                    {diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}
                  </small>
                </div>
              ))}
            </section>
          </aside>
      </div>
      <footer className="editor-statusbar" aria-label="Status bar">
          <span className="mono editor-statusbar-item">
            <GitBranch size={10} aria-hidden="true" />
            {detail.headRef || detail.headSha.slice(0, 7)}
          </span>
          <CheckoutDot tab={tab} />
          <span className="mono editor-statusbar-item">
            <span className={lspReady ? "editor-statusbar-dot is-ok" : "editor-statusbar-dot"} />
            Language server {lspReady ? "ready" : tab.mode === "managed" ? lspSession.data?.status ?? "idle" : "inactive"}
          </span>
          {tab.mode === "managed" && !lspReady ? (
            <button type="button" className="editor-statusbar-action" disabled={startLsp.isPending} onClick={() => startLsp.mutate()}>
              Start LSP
            </button>
          ) : null}
          <span className="editor-statusbar-spacer" />
          <span className="mono editor-statusbar-item">UTF-8</span>
          <span className="mono editor-statusbar-item">spaces: 2</span>
      </footer>
      {tab.finish.open ? <FinishReviewPopover tab={tab} onClose={() => setFinishOpen(tab.key, false)} /> : null}
    </main>
  );
}

function breadcrumb(path: string): React.JSX.Element {
  const parts = path.split("/");
  const last = parts.length - 1;
  return (
    <span className="editor-breadcrumb-parts mono">
      {parts.map((part, index) => (
        <span key={`${index}-${part}`} className={index === last ? "editor-breadcrumb-leaf" : "editor-breadcrumb-dir"}>
          {part}
          {index < last ? <ChevronRight size={10} aria-hidden="true" /> : null}
        </span>
      ))}
    </span>
  );
}

interface CheckoutDotProps {
  tab: PrTab;
}

function CheckoutDot({ tab }: CheckoutDotProps): React.JSX.Element {
  const isChecked = tab.checkout.state === "checked" || tab.mode === "managed";
  const isChecking = tab.checkout.state === "checking";
  return (
    <span className="mono editor-statusbar-item">
      <span
        className={
          isChecked
            ? "editor-statusbar-dot is-ok"
            : isChecking
              ? "editor-statusbar-dot is-warn"
              : "editor-statusbar-dot"
        }
      />
      {isChecked ? "checked out" : isChecking ? "checking out…" : "remote · not checked out"}
    </span>
  );
}
