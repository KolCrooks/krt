import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { ExtensionsView } from "./ExtensionsView.js";
import { PullRequestOverview } from "./PullRequestOverview.js";
import { Rail } from "./Rail.js";
import { SearchView } from "./SearchView.js";
import { SettingsView } from "./SettingsView.js";
import { TabStrip } from "./TabStrip.js";
import { TitleBar } from "./TitleBar.js";
import { useAppAppearance } from "../hooks/useAppAppearance.js";
import { useActiveTab, useUiStore } from "../store/uiStore.js";

const ReviewWorkspace = lazy(() => import("./ReviewWorkspace.js").then((module) => ({ default: module.ReviewWorkspace })));
const EditorWorkspace = lazy(() => import("./EditorWorkspace.js").then((module) => ({ default: module.EditorWorkspace })));

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
      <AppFrame />
    </QueryClientProvider>
  );
}

function AppFrame(): React.JSX.Element {
  useAppAppearance();
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const modal = useUiStore((state) => state.modal);
  const closeModal = useUiStore((state) => state.closeModal);
  const activeTab = useActiveTab();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape" && modal) {
        event.preventDefault();
        closeModal();
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
  }, [closeModal, modal, setActiveView]);

  return (
    <div className="app-shell">
      <TitleBar />
      <Rail />
      <div className="content-shell">
        <TabStrip />
        {activeView === "search" ? <SearchView /> : null}
        {activeTab && activeView === "overview" ? <PullRequestOverview tab={activeTab} /> : null}
        <Suspense fallback={<RouteLoading />}>
          {activeTab && activeView === "review" ? <ReviewWorkspace tab={activeTab} /> : null}
          {activeTab && activeView === "editor" ? <EditorWorkspace tab={activeTab} /> : null}
        </Suspense>
        {!activeTab && activeView !== "search" ? <EmptyWorkspace /> : null}
        {modal === "extensions" ? <ExtensionsView onClose={closeModal} /> : null}
        {modal === "settings" ? <SettingsView onClose={closeModal} /> : null}
      </div>
    </div>
  );
}

function RouteLoading(): React.JSX.Element {
  return (
    <div className="workspace-skeleton" aria-label="Loading workspace">
      <div className="workspace-skeleton-sidebar">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="skeleton skeleton-line skeleton-line-wide" key={index} />
        ))}
      </div>
      <div className="workspace-skeleton-main">
        <div className="skeleton skeleton-line skeleton-line-wide" />
        <div className="skeleton skeleton-line skeleton-line-narrow" />
        <div className="skeleton workspace-skeleton-block" />
        <div className="skeleton workspace-skeleton-block" />
      </div>
    </div>
  );
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
