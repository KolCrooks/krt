import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Columns2,
  FileText,
  GitPullRequestArrow,
  ListTree,
  Sparkles,
  SplitSquareHorizontal,
  Waypoints,
  X
} from "lucide-react";
import { krtClient } from "../api/client.js";
import type { PrTab, ReviewSubMode, TabViewMode } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";
import type { LspSession } from "../../shared/schemas.js";

type DiffLayout = "inline" | "split";

interface WorkspaceTabBarProps {
  tab: PrTab;
  mode: TabViewMode;
  active?: boolean;
  layout?: DiffLayout;
  onLayoutChange?: (layout: DiffLayout) => void;
  onFinishReview: () => void;
}

export function WorkspaceTabBar({
  tab,
  mode,
  active = true,
  layout = "inline",
  onLayoutChange,
  onFinishReview
}: WorkspaceTabBarProps): React.JSX.Element {
  const closeFile = useUiStore((state) => state.closeFile);
  const selectFile = useUiStore((state) => state.selectFile);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const setReviewSubMode = useUiStore((state) => state.setReviewSubMode);

  const isReviewMode = mode === "review";
  const reviewPillClass = isReviewMode ? "rev-tab rev-tab-review active" : "rev-tab rev-tab-review";

  return (
    <div className="rev-tabstrip">
      <button
        className={reviewPillClass}
        type="button"
        onClick={() => setTabViewMode(tab.key, "review")}
      >
        <GitPullRequestArrow size={13} aria-hidden="true" />
        <span>Review</span>
      </button>
      {tab.openFilePaths.map((path) => {
        const isActive = !isReviewMode && path === tab.selectedFilePath;
        return (
          <div className={isActive ? "rev-tab rev-tab-file active" : "rev-tab rev-tab-file"} key={path} title={path}>
            <button
              className="rev-tab-main"
              type="button"
              onClick={() => {
                selectFile(tab.key, path);
                setTabViewMode(tab.key, "editor");
              }}
            >
              <FileText size={12} aria-hidden="true" />
              <span className="mono">{path.split("/").at(-1)}</span>
            </button>
            <button
              className="rev-tab-x"
              type="button"
              aria-label={`Close ${path}`}
              onClick={(event) => {
                event.stopPropagation();
                closeFile(tab.key, path);
              }}
            >
              <X size={9} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      <span className="rev-tab-fill" aria-hidden="true" />
      <div className="rev-actions">
        <LspChip tab={tab} active={active} />
        {isReviewMode && onLayoutChange ? (
          <div className="rev-controls">
            <div className="segmented compact" aria-label="Review mode">
              <SubModeButton tab={tab} subMode="diff" label="Diff" icon={ListTree} onSelect={setReviewSubMode} />
              <SubModeButton tab={tab} subMode="tour" label="Tour" icon={Sparkles} onSelect={setReviewSubMode} />
              <SubModeButton tab={tab} subMode="storyboard" label="Storyboard" icon={Waypoints} onSelect={setReviewSubMode} />
            </div>
            <div className="segmented compact" aria-label="Diff layout">
              <button type="button" title="Inline diff" className={layout === "inline" ? "is-active" : ""} onClick={() => onLayoutChange("inline")}>
                <Columns2 size={13} aria-hidden="true" />
              </button>
              <button type="button" title="Split diff" className={layout === "split" ? "is-active" : ""} onClick={() => onLayoutChange("split")}>
                <SplitSquareHorizontal size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
        <button className="primary-button finish-review-button" type="button" onClick={onFinishReview}>
          <CheckCircle2 size={13} aria-hidden="true" />
          Finish review
        </button>
      </div>
    </div>
  );
}

interface SubModeButtonProps {
  tab: PrTab;
  subMode: ReviewSubMode;
  label: string;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  onSelect: (tabKey: string, subMode: ReviewSubMode) => void;
}

function SubModeButton({ tab, subMode, label, icon: Icon, onSelect }: SubModeButtonProps): React.JSX.Element {
  const active = tab.reviewSubMode === subMode;
  return (
    <button type="button" className={active ? "is-active" : ""} onClick={() => onSelect(tab.key, subMode)}>
      <Icon size={13} aria-hidden={true} />
      {label}
    </button>
  );
}

interface LspChipProps {
  tab: PrTab;
  active: boolean;
}

function LspChip({ tab, active }: LspChipProps): React.JSX.Element {
  const isManaged = tab.mode === "managed";
  const lspSession = useQuery({
    queryKey: ["lsp-session", tab.repository, tab.bundle.detail.headSha],
    enabled: active && isManaged,
    queryFn: () =>
      krtClient.lsp.getSession({
        repository: tab.bundle.detail.repository,
        headSha: tab.bundle.detail.headSha
      }),
    refetchInterval: active && isManaged ? 1_000 : false
  });
  const view = lspChipView(tab, lspSession.data ?? undefined, lspSession.isLoading);
  const entries = lspIndicatorEntries(tab, lspSession.data ?? undefined, view);

  return (
    <span className={`lsp-chip ${view.className}`} tabIndex={0} aria-label={view.title}>
      <span className="lsp-chip-dot" />
      <span className="lsp-chip-label">{view.label}</span>
      <span className="lsp-chip-popover" role="tooltip">
        <span className="lsp-chip-popover-heading">Language servers</span>
        {entries.map((entry) => (
          <span className="lsp-chip-popover-row" key={entry.id}>
            <span className={`lsp-chip-row-dot ${entry.className}`} />
            <span className="lsp-chip-row-body">
              <strong>{entry.id}</strong>
              <small>{entry.detail ? `${entry.status} - ${entry.detail}` : entry.status}</small>
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

interface LspChipView {
  label: string;
  title: string;
  className: string;
}

interface LspIndicatorEntry {
  id: string;
  status: string;
  detail?: string;
  className: string;
}

function lspChipView(tab: PrTab, session: LspSession | undefined, loading: boolean): LspChipView {
  if (tab.mode !== "managed") {
    if (tab.checkout.state === "checking") {
      return { label: "LSP pending", title: "Checking out branch before starting the language server.", className: "is-loading" };
    }
    return { label: "LSP off", title: "Check out branch to enable LSP.", className: "" };
  }

  if (loading && !session) {
    return { label: "LSP starting", title: "Checking language server status.", className: "is-loading" };
  }

  if (!session) {
    return { label: "LSP starting", title: "Language server startup has been requested.", className: "is-loading" };
  }

  const activities = session.activities?.length ? session.activities : session.activity ? [session.activity] : [];
  if (activities.length === 1 && activities[0]) {
    return {
      label: `${extensionLabel(activities[0].extensionId)} ${activityLabel(activities[0])}`,
      title: activityTitle(activities[0]),
      className: "is-loading"
    };
  }
  if (activities.length > 1) {
    return {
      label: `${activities.length} LSPs working`,
      title: activities.map(activityTitle).join("; "),
      className: "is-loading"
    };
  }

  const serverStatuses = (session.serverStatuses?.length ? session.serverStatuses : session.serverStatus ? [session.serverStatus] : [])
    .filter((status) => !status.quiescent || status.health !== "ok");
  if (serverStatuses.length === 1 && serverStatuses[0]) {
    const status = serverStatuses[0];
    const label = status.message || status.health;
    return {
      label: `${extensionLabel(status.extensionId)} ${label}`,
      title: status.message ?? `Language server health: ${status.health}.`,
      className: status.health === "error" ? "is-error" : "is-warn"
    };
  }
  if (serverStatuses.length > 1) {
    return {
      label: `${serverStatuses.length} LSPs active`,
      title: serverStatuses.map(serverStatusTitle).join("; "),
      className: serverStatuses.some((status) => status.health === "error") ? "is-error" : "is-warn"
    };
  }

  if (session.status === "ready") {
    if (session.activeExtensions.length > 1) {
      return {
        label: `${session.activeExtensions.length} LSPs ready`,
        title: `Active: ${session.activeExtensions.join(", ")}`,
        className: "is-on"
      };
    }
    return {
      label: `${extensionLabel(session.activeExtensions[0])} ready`,
      title: "Language server is ready.",
      className: "is-on"
    };
  }

  if (session.status === "starting") {
    return { label: "LSP starting", title: "Language server is starting.", className: "is-loading" };
  }

  if (session.status === "degraded") {
    return {
      label: "LSP degraded",
      title: session.unavailableExtensions[0]?.reason ?? "One or more language servers are unavailable.",
      className: "is-warn"
    };
  }

  if (session.status === "error") {
    return { label: "LSP error", title: session.error ?? "Language server failed.", className: "is-error" };
  }

  return { label: "LSP stopped", title: "Language server is stopped.", className: "" };
}

function extensionLabel(extensionId: string | undefined): string {
  return extensionId ?? "LSP";
}

function lspIndicatorEntries(tab: PrTab, session: LspSession | undefined, view: LspChipView): LspIndicatorEntry[] {
  if (!session) {
    return [
      {
        id: "language-server",
        status: tab.mode === "managed" ? view.label : "Off",
        detail: view.title,
        className: view.className || "is-off"
      }
    ];
  }

  const entries = new Map<string, LspIndicatorEntry>();
  for (const extensionId of session.activeExtensions) {
    entries.set(extensionId, {
      id: extensionId,
      status: "Ready",
      className: "is-ready"
    });
  }
  for (const unavailable of session.unavailableExtensions) {
    entries.set(unavailable.id, {
      id: unavailable.id,
      status: "Unavailable",
      detail: unavailable.reason,
      className: "is-error"
    });
  }
  const serverStatuses = session.serverStatuses?.length ? session.serverStatuses : session.serverStatus ? [session.serverStatus] : [];
  for (const status of serverStatuses) {
    const state = status.health === "error" ? "Error" : status.health === "warning" ? "Warning" : status.quiescent ? "Ready" : "Active";
    entries.set(status.extensionId, {
      id: status.extensionId,
      status: state,
      detail: status.message,
      className: status.health === "error" ? "is-error" : status.health === "warning" ? "is-warn" : status.quiescent ? "is-ready" : "is-working"
    });
  }
  const activities = session.activities?.length ? session.activities : session.activity ? [session.activity] : [];
  for (const activity of activities) {
    entries.set(activity.extensionId, {
      id: activity.extensionId,
      status: "Working",
      detail: activityLabel(activity),
      className: "is-working"
    });
  }

  if (entries.size === 0) {
    return [
      {
        id: "language-server",
        status: view.label,
        detail: view.title,
        className: view.className || "is-off"
      }
    ];
  }
  return [...entries.values()];
}

function activityLabel(activity: NonNullable<LspSession["activity"]>): string {
  const detail = activity.message && activity.message !== activity.title
    ? `${activity.title} ${activity.message}`
    : activity.title;
  return typeof activity.percentage === "number" ? `${detail} ${activity.percentage}%` : detail;
}

function activityTitle(activity: NonNullable<LspSession["activity"]>): string {
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
