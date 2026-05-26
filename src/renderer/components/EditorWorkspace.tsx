import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, GitBranch, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { krtClient } from "../api/client.js";
import { CodeFilePanel } from "./diffs/DiffPanel.js";
import { FinishReviewPopover } from "./FinishReviewPopover.js";
import { CheckoutBanner } from "./review/CheckoutBanner.js";
import { WorkspaceFileTree } from "./trees/WorkspaceFileTree.js";
import { WorkspaceTabBar } from "./WorkspaceTabBar.js";
import { useEnsureLspSession } from "../hooks/useEnsureLspSession.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";
import type { LspSession } from "../../shared/schemas.js";

interface EditorWorkspaceProps {
  tab: PrTab;
  active?: boolean;
}

export function EditorWorkspace({ tab, active = true }: EditorWorkspaceProps): React.JSX.Element {
  const queryClient = useQueryClient();
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
  useEnsureLspSession({
    enabled: active && tab.mode === "managed",
    repository: detail.repository,
    headSha: detail.headSha,
    paths: tab.selectedFilePath ? [tab.selectedFilePath] : []
  });
  const lspSession = useQuery({
    queryKey: ["lsp-session", tab.repository, detail.headSha],
    enabled: active && tab.mode === "managed",
    queryFn: () =>
      krtClient.lsp.getSession({
        repository: detail.repository,
        headSha: detail.headSha
      }),
    refetchInterval: active && tab.mode === "managed" ? 1_000 : false
  });
  const canLoadBackgroundLspData = Boolean(
    active &&
    tab.mode === "managed" &&
    tab.selectedFilePath &&
    lspSession.data &&
    lspSession.data.status !== "starting"
  );
  const diagnostics = useQuery({
    queryKey: ["lsp-diagnostics", tab.repository, detail.headSha, tab.selectedFilePath],
    enabled: canLoadBackgroundLspData,
    queryFn: () =>
      krtClient.lsp.getDiagnostics({
        repository: detail.repository,
        headSha: detail.headSha,
        path: tab.selectedFilePath ?? undefined
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
      if (!change.path || change.path === tab.selectedFilePath) {
        void queryClient.invalidateQueries({ queryKey: ["file-content", tab.repository, detail.headSha] });
      }
    });
  }, [detail.headSha, detail.repository.fullName, detail.repository.provider, queryClient, tab.mode, tab.repository, tab.selectedFilePath]);

  const inThisPrPaths = tab.bundle.changedFiles.map((file) => file.path);
  const fileIsInPr = tab.selectedFilePath ? inThisPrPaths.includes(tab.selectedFilePath) : false;
  const lspStatus = lspStatusView(tab.mode, lspSession.data ?? undefined, lspSession.isLoading);
  const editorNavigationTarget =
    tab.editorNavigationTarget?.path === tab.selectedFilePath ? tab.editorNavigationTarget : null;
  const handleOpenDefinition = useCallback(
    (definitionPath: string, line: number) => openFileInTab(tab.key, definitionPath, line),
    [openFileInTab, tab.key]
  );

  return (
    <main className="view editor-workspace">
      <CheckoutBanner tab={tab} />
      <WorkspaceTabBar tab={tab} mode="editor" active={active} onFinishReview={() => setFinishOpen(tab.key, true)} />
      <div className="editor-body">
        <aside className="workspace-sidebar">
          <EditorWorkspaceFileTree
            mode={tab.mode}
            paths={managedPaths}
            loading={workspaceTree.isLoading}
            error={workspaceTree.isError}
            selectedPath={tab.selectedFilePath}
            onSelectPath={(path) => openFileInTab(tab.key, path)}
          />
        </aside>
        <section className="editor-pane">
          {tab.selectedFilePath ? (
            <div className="editor-breadcrumb" aria-label="File path">
              {breadcrumb(tab.selectedFilePath)}
              <span className="editor-breadcrumb-spacer" />
              <span className="mono editor-breadcrumb-cursor">Ln {editorNavigationTarget?.line ?? 1}, Col 1</span>
            </div>
          ) : null}
          {tab.selectedFilePath ? (
            <div className="editor-file-pane is-active" key={tab.selectedFilePath}>
              <CodeFilePanel
                pullRequest={detail}
                path={tab.selectedFilePath}
                active={active}
                enableLsp={active && tab.mode === "managed"}
                targetLine={editorNavigationTarget?.line ?? null}
                navigationKey={editorNavigationTarget?.requestId ?? null}
                onOpenDefinition={handleOpenDefinition}
              />
            </div>
          ) : (
            <CodeFilePanel
              pullRequest={detail}
              path={null}
              active={active}
            />
          )}
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
        <span className="mono editor-statusbar-item" title={lspStatus.title}>
          <span className={lspStatus.ready ? "editor-statusbar-dot is-ok" : "editor-statusbar-dot"} />
          Language server {lspStatus.label}
        </span>
        <span className="editor-statusbar-spacer" />
        <span className="mono editor-statusbar-item">UTF-8</span>
        <span className="mono editor-statusbar-item">spaces: 2</span>
      </footer>
      {tab.finish.open ? <FinishReviewPopover tab={tab} onClose={() => setFinishOpen(tab.key, false)} /> : null}
    </main>
  );
}

interface EditorWorkspaceFileTreeProps {
  mode: PrTab["mode"];
  paths: string[];
  loading: boolean;
  error: boolean;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}

function EditorWorkspaceFileTree({
  mode,
  paths,
  loading,
  error,
  selectedPath,
  onSelectPath
}: EditorWorkspaceFileTreeProps): React.JSX.Element {
  if (mode !== "managed") {
    return <EditorTreeState message="Check out this PR to browse workspace files." />;
  }
  if (loading) {
    return <EditorTreeState message="Loading workspace files." />;
  }
  if (error) {
    return <EditorTreeState message="Workspace files are unavailable." />;
  }
  if (paths.length === 0) {
    return <EditorTreeState message="No workspace files found." />;
  }
  return (
    <WorkspaceFileTree
      paths={paths}
      selectedPath={selectedPath}
      initialExpansion="closed"
      onSelectPath={onSelectPath}
    />
  );
}

function EditorTreeState({ message }: { message: string }): React.JSX.Element {
  return <div className="editor-tree-state">{message}</div>;
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

interface LspStatusView {
  label: string;
  ready: boolean;
  title?: string;
}

function lspStatusView(mode: string, session: LspSession | undefined, loading: boolean): LspStatusView {
  if (mode !== "managed") {
    return { label: "inactive", ready: false };
  }
  if (loading && !session) {
    return { label: "starting", ready: false };
  }
  if (!session) {
    return { label: "starting", ready: false };
  }

  const activities = session.activities?.length ? session.activities : session.activity ? [session.activity] : [];
  if (activities.length === 1 && activities[0]) {
    return {
      label: activityStatusLabel(activities[0]),
      ready: false,
      title: activityStatusTitle(activities[0])
    };
  }
  if (activities.length > 1) {
    return {
      label: `${activities.length} LSPs working`,
      ready: false,
      title: activities.map(activityStatusTitle).join("; ")
    };
  }

  const serverStatuses = (session.serverStatuses?.length ? session.serverStatuses : session.serverStatus ? [session.serverStatus] : [])
    .filter((status) => !status.quiescent || status.health !== "ok");
  if (serverStatuses.length === 1 && serverStatuses[0]) {
    const status = serverStatuses[0];
    return {
      label: status.message ?? status.health,
      ready: false,
      title: status.message ?? `Language server health: ${status.health}.`
    };
  }
  if (serverStatuses.length > 1) {
    return {
      label: `${serverStatuses.length} LSPs active`,
      ready: false,
      title: serverStatuses.map(serverStatusTitle).join("; ")
    };
  }

  if (session.activeExtensions.length > 0) {
    if (session.activeExtensions.length > 1) {
      return {
        label: `${session.activeExtensions.length} LSPs ready`,
        ready: true,
        title: session.unavailableExtensions.length > 0
          ? unavailableExtensionsTitle(session)
          : `Active: ${session.activeExtensions.join(", ")}`
      };
    }
    return {
      label: "ready",
      ready: true,
      title: session.unavailableExtensions.length > 0
        ? unavailableExtensionsTitle(session)
        : `Active: ${session.activeExtensions.join(", ")}`
    };
  }

  if (session.status === "degraded") {
    return {
      label: "unavailable",
      ready: false,
      title: unavailableExtensionsTitle(session)
    };
  }

  return { label: session.status, ready: session.status === "ready" };
}

function activityStatusLabel(activity: NonNullable<LspSession["activity"]>): string {
  const detail = activity.message && activity.message !== activity.title
    ? `${activity.title} ${activity.message}`
    : activity.title;
  return typeof activity.percentage === "number" ? `${detail} ${activity.percentage}%` : detail;
}

function activityStatusTitle(activity: NonNullable<LspSession["activity"]>): string {
  const parts = [`${activity.extensionId}: ${activity.title}`];
  if (activity.message && activity.message !== activity.title) {
    parts.push(activity.message);
  }
  if (typeof activity.percentage === "number") {
    parts.push(`${activity.percentage}%`);
  }
  return parts.join(" - ");
}

function serverStatusTitle(status: NonNullable<LspSession["serverStatus"]>): string {
  const parts = [`${status.extensionId}: ${status.health}`];
  if (status.message) {
    parts.push(status.message);
  }
  return parts.join(" - ");
}

function unavailableExtensionsTitle(session: LspSession): string {
  const active = session.activeExtensions.length > 0
    ? `Active: ${session.activeExtensions.join(", ")}. `
    : "";
  const unavailable = session.unavailableExtensions.length > 0
    ? session.unavailableExtensions.map((extension) => `${extension.id}: ${extension.reason}`).join(" ")
    : "No language server extension is available for this workspace.";
  return `${active}${unavailable}`;
}
