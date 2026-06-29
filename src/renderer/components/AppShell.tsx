import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExtensionsView } from "./ExtensionsView.js";
import { EditorWorkspace } from "./EditorWorkspace.js";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider.js";
import { PullRequestOverview } from "./PullRequestOverview.js";
import { Rail } from "./Rail.js";
import { ReviewWorkspace } from "./ReviewWorkspace.js";
import { SearchView } from "./SearchView.js";
import { SettingsView } from "./SettingsView.js";
import { TabStrip } from "./TabStrip.js";
import { TitleBar } from "./TitleBar.js";
import { TourGenerationManager } from "./TourGenerationManager.js";
import { TourChatManager } from "./TourChatManager.js";
import { krtClient } from "../api/client.js";
import { useAppAppearance } from "../hooks/useAppAppearance.js";
import { useEnsureLspSession } from "../hooks/useEnsureLspSession.js";
import { tabKey, useActiveTab, useUiStore, type PrTab } from "../store/uiStore.js";
import type { RepositoryRef } from "../../shared/schemas.js";

type CloseSubTabCommandSource = "keyboard" | "menu";

export function AppShell(): React.JSX.Element {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1
          }
        }
      }),
    []
  );

  return (
    <QueryClientProvider client={queryClient}>
      <DiffWorkerPoolProvider>
        <AppFrame />
      </DiffWorkerPoolProvider>
    </QueryClientProvider>
  );
}

function AppFrame(): React.JSX.Element {
  useAppAppearance();
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const modal = useUiStore((state) => state.modal);
  const openModal = useUiStore((state) => state.openModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const tabs = useUiStore((state) => state.tabs);
  const openPrTab = useUiStore((state) => state.openPrTab);
  const selectTab = useUiStore((state) => state.selectTab);
  const closeFile = useUiStore((state) => state.closeFile);
  const activeTab = useActiveTab();
  const hydratedWorktreeTabs = useRef(false);
  const lastCloseSubTabCommand = useRef<{ source: CloseSubTabCommandSource; at: number } | null>(null);
  const [mountedWorkspaceViews, setMountedWorkspaceViews] = useState<Set<string>>(() => new Set());
  useStopRemovedLspSessions(tabs);
  const closeActiveFileSubTab = useCallback(() => {
    if (modal || activeView !== "editor" || !activeTab?.selectedFilePath) {
      return;
    }
    if (!activeTab.openFilePaths.includes(activeTab.selectedFilePath)) {
      return;
    }
    closeFile(activeTab.key, activeTab.selectedFilePath);
  }, [activeTab, activeView, closeFile, modal]);
  const runCloseSubTabCommand = useCallback(
    (source: CloseSubTabCommandSource) => {
      const now = performance.now();
      const previous = lastCloseSubTabCommand.current;
      if (previous && previous.source !== source && now - previous.at < 100) {
        return;
      }
      lastCloseSubTabCommand.current = { source, at: now };
      closeActiveFileSubTab();
    },
    [closeActiveFileSubTab]
  );

  useEffect(() => {
    if (!activeTab || (activeView !== "review" && activeView !== "editor")) {
      return;
    }
    const key = workspaceViewKey(activeTab.key, activeView);
    setMountedWorkspaceViews((previous) => {
      if (previous.has(key)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(key);
      return next;
    });
  }, [activeTab, activeView]);

  useEffect(() => {
    if (!activeTab) {
      setMountedWorkspaceViews((previous) => (previous.size === 0 ? previous : new Set()));
      return;
    }
    const validKeys = new Set(tabs.flatMap((tab) => [workspaceViewKey(tab.key, "review"), workspaceViewKey(tab.key, "editor")]));
    setMountedWorkspaceViews((previous) => {
      const next = new Set([...previous].filter((key) => validKeys.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [activeTab, tabs]);

  useEffect(() => {
    if (hydratedWorktreeTabs.current) {
      return undefined;
    }
    hydratedWorktreeTabs.current = true;
    let cancelled = false;

    void (async () => {
      const worktrees = await krtClient.repos.listManagedWorktrees().catch(() => []);
      if (worktrees.length === 0 || cancelled) {
        return;
      }

      const bundles = (
        await Promise.all(
          worktrees.map(async (worktree) => {
            try {
              return await krtClient.pullRequests.open({
                repository: worktree.repository,
                number: worktree.number,
                preferredMode: "managed"
              });
            } catch {
              return null;
            }
          })
        )
      ).filter((bundle) => bundle !== null);

      if (cancelled || bundles.length === 0) {
        return;
      }

      for (const bundle of bundles) {
        openPrTab(bundle);
      }
      const first = bundles[0];
      selectTab(tabKey(first.detail.repository.fullName, first.detail.number));
    })();

    return () => {
      cancelled = true;
    };
  }, [openPrTab, selectTab]);

  useEffect(() => krtClient.app.onCloseSubTab(() => runCloseSubTabCommand("menu")), [runCloseSubTabCommand]);
  useEffect(() => krtClient.app.onOpenPreferences(() => openModal("settings")), [openModal]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape" && modal) {
        event.preventDefault();
        closeModal();
        return;
      }
      if (isCloseSubTabShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        runCloseSubTabCommand("keyboard");
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        event.stopPropagation();
        openModal("settings");
        return;
      }
      // Cmd/Ctrl+K opens search globally
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (modal) {
          closeModal();
        }
        setActiveView("search");
        return;
      }
      // "/" focuses search when not inside an editable element
      if (event.key === "/" && !isEditableTarget(target)) {
        event.preventDefault();
        if (modal) {
          closeModal();
        }
        setActiveView("search");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeModal, modal, openModal, runCloseSubTabCommand, setActiveView]);

  return (
    <div className="app-shell">
      <TitleBar />
      <OpenPrLspSessions tabs={tabs} />
      <TourGenerationManager />
      <TourChatManager />
      <Rail />
      <div className="content-shell">
        <TabStrip />
        {activeView === "search" ? <SearchView /> : null}
        {activeTab && activeView === "overview" ? <PullRequestOverview tab={activeTab} /> : null}
        {tabs.flatMap((tab) => {
          const reviewActive = isWorkspaceViewActive(tab.key, "review", activeTab?.key ?? null, activeView);
          const editorActive = isWorkspaceViewActive(tab.key, "editor", activeTab?.key ?? null, activeView);
          return [
            shouldMountWorkspaceView(tab.key, "review", activeTab?.key ?? null, activeView, mountedWorkspaceViews) ? (
              <div
                className={reviewActive ? "workspace-view-pane is-active" : "workspace-view-pane"}
                aria-hidden={!reviewActive}
                key={workspaceViewKey(tab.key, "review")}
              >
                <ReviewWorkspace tab={tab} active={reviewActive} />
              </div>
            ) : null,
            shouldMountWorkspaceView(tab.key, "editor", activeTab?.key ?? null, activeView, mountedWorkspaceViews) ? (
              <div
                className={editorActive ? "workspace-view-pane is-active" : "workspace-view-pane"}
                aria-hidden={!editorActive}
                key={workspaceViewKey(tab.key, "editor")}
              >
                <EditorWorkspace tab={tab} active={editorActive} />
              </div>
            ) : null
          ];
        })}
        {!activeTab && activeView !== "search" ? <EmptyWorkspace /> : null}
        {modal === "extensions" ? <ExtensionsView onClose={closeModal} /> : null}
        {modal === "settings" ? <SettingsView onClose={closeModal} /> : null}
      </div>
    </div>
  );
}

function shouldMountWorkspaceView(
  tabKeyValue: string,
  view: "review" | "editor",
  activeTabKey: string | null,
  activeView: string,
  mountedWorkspaceViews: ReadonlySet<string>
): boolean {
  return isWorkspaceViewActive(tabKeyValue, view, activeTabKey, activeView) || mountedWorkspaceViews.has(workspaceViewKey(tabKeyValue, view));
}

function isWorkspaceViewActive(
  tabKeyValue: string,
  view: "review" | "editor",
  activeTabKey: string | null,
  activeView: string
): boolean {
  return activeTabKey === tabKeyValue && activeView === view;
}

function workspaceViewKey(tabKeyValue: string, view: "review" | "editor"): string {
  return `${tabKeyValue}:${view}`;
}

function isCloseSubTabShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w";
}

function OpenPrLspSessions({ tabs }: { tabs: PrTab[] }): React.JSX.Element {
  return (
    <>
      {tabs.map((tab) =>
        tab.mode === "managed" ? <PrTabLspSession key={`${tab.key}:${tab.bundle.detail.headSha}`} tab={tab} /> : null
      )}
    </>
  );
}

function PrTabLspSession({ tab }: { tab: PrTab }): null {
  useEnsureLspSession({
    enabled: tab.mode === "managed",
    repository: tab.bundle.detail.repository,
    headSha: tab.bundle.detail.headSha,
    paths: lspPathsForTab(tab)
  });
  return null;
}

interface LspSessionIdentity {
  repository: RepositoryRef;
  headSha: string;
}

function useStopRemovedLspSessions(tabs: PrTab[]): void {
  const previousSessions = useRef<Map<string, LspSessionIdentity>>(new Map());

  useEffect(() => {
    const nextSessions = new Map<string, LspSessionIdentity>();
    for (const tab of tabs) {
      if (tab.mode !== "managed") {
        continue;
      }
      const identity = {
        repository: tab.bundle.detail.repository,
        headSha: tab.bundle.detail.headSha
      };
      nextSessions.set(lspSessionKey(identity.repository, identity.headSha), identity);
    }

    for (const [key, previous] of previousSessions.current) {
      if (nextSessions.has(key)) {
        continue;
      }
      void krtClient.lsp.stopForWorktree(previous).catch(() => undefined);
    }

    previousSessions.current = nextSessions;
  }, [tabs]);
}

function lspSessionKey(repository: RepositoryRef, headSha: string): string {
  return `${repository.provider}:${repository.fullName}:${headSha}`;
}

function lspPathsForTab(tab: PrTab): string[] {
  return tab.bundle.changedFiles.filter((file) => !file.isLarge && file.status !== "removed").map((file) => file.path);
}

function EmptyWorkspace(): React.JSX.Element {
  return (
    <main className="view">
      <div className="empty-panel">
        <span>No pull request tab is open</span>
      </div>
    </main>
  );
}

function isEditableTarget(target: HTMLElement | null): boolean {
  if (!target) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
