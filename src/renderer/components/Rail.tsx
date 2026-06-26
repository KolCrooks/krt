import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Code2, GitPullRequestArrow, ListTree, Puzzle, RefreshCw, RotateCw, Search, Settings, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { krtClient } from "../api/client.js";
import { formatDate } from "../lib/format.js";
import type { AppView, TabViewMode } from "../store/uiStore.js";
import { useActiveTab, useUiStore } from "../store/uiStore.js";
import type { IpcOutput } from "../../shared/ipc.js";

type Extension = IpcOutput<"extensions:list">[number];
type ExtensionLog = IpcOutput<"extensions:logs">[number];

const prItems: Array<{ view: TabViewMode; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { view: "overview", label: "Overview", icon: GitPullRequestArrow },
  { view: "review", label: "Review", icon: ListTree },
  { view: "editor", label: "Editor", icon: Code2 }
];

export function Rail(): React.JSX.Element {
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const modal = useUiStore((state) => state.modal);
  const openModal = useUiStore((state) => state.openModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const activeTab = useActiveTab();

  const handlePrModeClick = (mode: TabViewMode): void => {
    if (modal) {
      closeModal();
    }
    if (activeTab) {
      setTabViewMode(activeTab.key, mode);
    } else {
      setActiveView(mode);
    }
  };

  const handleSearchClick = (): void => {
    if (modal) {
      closeModal();
    }
    setActiveView("search");
  };

  const toggleModal = (name: "extensions" | "settings"): void => {
    if (modal === name) {
      closeModal();
    } else {
      openModal(name);
    }
  };

  return (
    <nav className="rail" aria-label="Primary">
      <RailButton active={activeView === "search" && !modal} label="Search" icon={Search} onClick={handleSearchClick} />
      <div className="rail-sep" />
      <div className={activeTab ? "rail-group" : "rail-group hidden"}>
        {prItems.map((item) => (
          <RailButton
            active={!modal && activeTab ? activeTab.viewMode === item.view : false}
            icon={item.icon}
            key={item.view}
            label={item.label}
            onClick={() => handlePrModeClick(item.view)}
          />
        ))}
      </div>
      <div className="rail-spacer" />
      <ExtensionsRailButton active={modal === "extensions"} onOpen={() => toggleModal("extensions")} />
      <RailButton active={modal === "settings"} label="Settings" icon={Settings} onClick={() => toggleModal("settings")} />
    </nav>
  );
}

function RailButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={active ? "rail-btn active" : "rail-btn"}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={18} aria-hidden="true" />
      <span className="rail-tooltip" aria-hidden="true">{label}</span>
    </button>
  );
}

interface ExtensionsRailButtonProps {
  active: boolean;
  onOpen: () => void;
}

function ExtensionsRailButton({ active, onOpen }: ExtensionsRailButtonProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ top?: number; bottom?: number; left: number }>({ top: 0, left: 70 });

  const extensionsQuery = useQuery({
    queryKey: ["extensions"],
    queryFn: () => krtClient.extensions.list(),
    enabled: open
  });
  const logsQuery = useQuery({
    queryKey: ["extension-logs"],
    queryFn: () => krtClient.extensions.logs(),
    enabled: open
  });

  const restartMutation = useMutation({
    mutationFn: async (extensionId: string) => {
      await krtClient.extensions.setEnabled({ extensionId, enabled: false });
      return krtClient.extensions.setEnabled({ extensionId, enabled: true });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["extensions"] });
      void queryClient.invalidateQueries({ queryKey: ["extension-logs"] });
    }
  });

  const reloadMutation = useMutation({
    mutationFn: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workspace-tree"] }),
        queryClient.invalidateQueries({ queryKey: ["lsp-session"] }),
        queryClient.invalidateQueries({ queryKey: ["lsp-diagnostics"] }),
        queryClient.invalidateQueries({ queryKey: ["file-content"] }),
        queryClient.invalidateQueries({ queryKey: ["file-patch"] }),
        queryClient.invalidateQueries({ queryKey: ["extensions"] }),
        queryClient.invalidateQueries({ queryKey: ["extension-logs"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-text-search"] })
      ]);
      return true;
    }
  });

  const enabled = useMemo(
    () => (extensionsQuery.data ?? []).filter((extension) => extension.enabled),
    [extensionsQuery.data]
  );
  const selected = enabled.find((extension) => extension.id === selectedId) ?? null;
  const selectedLogs = useMemo(
    () => (selected ? (logsQuery.data ?? []).filter((log) => log.extensionId === selected.id) : []),
    [logsQuery.data, selected]
  );

  const cancelClose = (): void => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = (): void => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setSelectedId(null);
    }, 150);
  };
  useEffect(() => () => cancelClose(), []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    const POPOVER_H = 420;
    const PAD = 12;
    const vh = window.innerHeight;
    const left = rect.right + 10;
    if (rect.top + POPOVER_H > vh - PAD) {
      setAnchor({ bottom: vh - rect.bottom, left });
    } else {
      setAnchor({ top: rect.top, left });
    }
  }, [open]);

  return (
    <div
      ref={wrapperRef}
      className="rail-popover-wrapper"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        ref={buttonRef}
        className={active ? "rail-btn active" : "rail-btn"}
        type="button"
        aria-label="Extensions"
        onClick={onOpen}
      >
        <Puzzle size={18} aria-hidden="true" />
        <span className="rail-tooltip" aria-hidden="true" style={open ? { opacity: 0 } : undefined}>
          Extensions
        </span>
      </button>
      {open ? (
        <div
          className="ext-popover"
          style={{
            left: anchor.left,
            top: anchor.top,
            bottom: anchor.bottom,
            width: selected ? 700 : 320
          }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          role="dialog"
          aria-label="Active extensions"
        >
          <div className="ext-popover-list">
            <div className="ext-popover-header">
              <span className="ext-popover-eyebrow">Active extensions</span>
              <span className="chip ext-popover-count">{enabled.length}</span>
              <span className="ext-popover-spacer" />
              <button type="button" className="ext-popover-manage" onClick={onOpen}>Manage…</button>
            </div>
            <div className="ext-popover-rows">
              {extensionsQuery.isLoading ? (
                <div className="ext-popover-empty">Loading extensions…</div>
              ) : null}
              {!extensionsQuery.isLoading && enabled.length === 0 ? (
                <div className="ext-popover-empty">No extensions enabled.</div>
              ) : null}
              {enabled.map((extension) => (
                <ExtensionPopoverRow
                  key={extension.id}
                  extension={extension}
                  selected={extension.id === selectedId}
                  onSelect={() => setSelectedId((current) => (current === extension.id ? null : extension.id))}
                />
              ))}
            </div>
            <div className="ext-popover-footer">
              <button
                type="button"
                className="ext-popover-reload"
                onClick={() => reloadMutation.mutate()}
                disabled={reloadMutation.isPending}
                title="Refetch workspace tree, LSP session, diagnostics, and file contents"
              >
                <RotateCw size={11} aria-hidden="true" className={reloadMutation.isPending ? "spin" : undefined} />
                {reloadMutation.isPending ? "Reloading…" : "Reload workspace"}
              </button>
            </div>
          </div>
          {selected ? (
            <ExtensionLogsPane
              extension={selected}
              logs={selectedLogs}
              restarting={restartMutation.isPending && restartMutation.variables === selected.id}
              onRestart={() => restartMutation.mutate(selected.id)}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface ExtensionPopoverRowProps {
  extension: Extension;
  selected: boolean;
  onSelect: () => void;
}

function ExtensionPopoverRow({ extension, selected, onSelect }: ExtensionPopoverRowProps): React.JSX.Element {
  const status = extensionStatus(extension);
  return (
    <button
      type="button"
      className={selected ? "ext-popover-row is-selected" : "ext-popover-row"}
      onClick={onSelect}
    >
      <span className="ext-popover-icon" style={{ background: paletteFor(extension.id) }}>
        {glyphFor(extension.name)}
      </span>
      <div className="ext-popover-row-body">
        <div className="ext-popover-row-name">{extension.name}</div>
        <div className="ext-popover-row-meta">
          <span className={`ext-status-dot is-${status.state}`} aria-hidden="true" />
          <span>{status.label}</span>
          {status.detail ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="mono">{status.detail}</span>
            </>
          ) : null}
        </div>
      </div>
      <ChevronRight size={9} aria-hidden="true" className="ext-popover-row-chevron" />
    </button>
  );
}

interface ExtensionLogsPaneProps {
  extension: Extension;
  logs: ExtensionLog[];
  restarting: boolean;
  onRestart: () => void;
  onClose: () => void;
}

function ExtensionLogsPane({ extension, logs, restarting, onRestart, onClose }: ExtensionLogsPaneProps): React.JSX.Element {
  return (
    <div className="ext-popover-logs">
      <div className="ext-popover-logs-head">
        <span className="ext-popover-icon ext-popover-icon-sm" style={{ background: paletteFor(extension.id) }}>
          {glyphFor(extension.name)}
        </span>
        <div className="ext-popover-logs-head-body">
          <div className="ext-popover-logs-name">{extension.name}</div>
          <div className="ext-popover-logs-subtitle">output channel</div>
        </div>
        <button
          type="button"
          className="ext-popover-logs-action"
          aria-label="Restart extension"
          title="Restart extension"
          onClick={onRestart}
          disabled={restarting}
        >
          <RefreshCw size={11} aria-hidden="true" className={restarting ? "spin" : undefined} />
          {restarting ? "Restarting" : "Restart"}
        </button>
        <button type="button" className="ext-popover-logs-close" aria-label="Back" onClick={onClose}>
          <X size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="ext-popover-logs-body">
        {logs.length === 0 ? (
          <div className="ext-popover-logs-empty">No recent activity.</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="ext-popover-logs-row">
              <span className="ext-popover-logs-ts">{formatDate(log.createdAt)}</span>
              <span className={`ext-popover-logs-level is-${log.level}`}>{log.level}</span>
              <span className="ext-popover-logs-msg">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface StatusMeta {
  state: "running" | "idle" | "error";
  label: string;
  detail?: string;
}

function extensionStatus(extension: Extension): StatusMeta {
  if (!extension.enabled) {
    return { state: "idle", label: "Disabled" };
  }
  if (extension.activationGlobs.length === 0) {
    return { state: "running", label: "Running" };
  }
  return {
    state: "running",
    label: "Running",
    detail: extension.activationGlobs.slice(0, 2).join(" · ")
  };
}

const PALETTES = [
  "oklch(0.55 0.15 25)",
  "oklch(0.55 0.14 250)",
  "oklch(0.6 0.15 75)",
  "oklch(0.5 0.12 200)",
  "#8b5cf6",
  "oklch(0.55 0.13 145)",
  "oklch(0.65 0.12 200)",
  "oklch(0.55 0.18 30)"
];

function paletteFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PALETTES[hash % PALETTES.length];
}

function glyphFor(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned.length === 0) {
    return "?";
  }
  if (cleaned.length === 1) {
    return cleaned[0].toUpperCase();
  }
  return cleaned.slice(0, 2).toLowerCase();
}
