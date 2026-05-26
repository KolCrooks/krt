import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { krtClient } from "../api/client.js";
import { formatDate } from "../lib/format.js";
import type { IpcOutput } from "../../shared/ipc.js";

type Extension = IpcOutput<"extensions:list">[number];
type ExtensionLog = IpcOutput<"extensions:logs">[number];

type ExtensionKind = "language" | "review" | "linter" | "other";

const CATEGORIES: Array<{ id: "all" | "enabled" | "disabled" | ExtensionKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "enabled", label: "Enabled" },
  { id: "disabled", label: "Disabled" },
  { id: "language", label: "Languages" },
  { id: "linter", label: "Linters & formatters" },
  { id: "review", label: "Review tools" }
];

interface ExtensionsViewProps {
  onClose: () => void;
}

export function ExtensionsView({ onClose }: ExtensionsViewProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const extensionsQuery = useQuery({
    queryKey: ["extensions"],
    queryFn: () => krtClient.extensions.list()
  });
  const logsQuery = useQuery({
    queryKey: ["extension-logs"],
    queryFn: () => krtClient.extensions.logs()
  });
  const toggleMutation = useMutation({
    mutationFn: (input: { extensionId: string; enabled: boolean }) => krtClient.extensions.setEnabled(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["extensions"] });
      void queryClient.invalidateQueries({ queryKey: ["extension-logs"] });
    }
  });

  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const extensions = extensionsQuery.data ?? [];
  const logs = logsQuery.data ?? [];
  const counts = useMemo(() => countByCategory(extensions), [extensions]);
  const filtered = useMemo(() => filterExtensions(extensions, category, query), [extensions, category, query]);
  const active = useMemo(() => {
    if (selectedId) {
      const match = extensions.find((ext) => ext.id === selectedId);
      if (match) {
        return match;
      }
    }
    return filtered[0] ?? extensions[0] ?? null;
  }, [extensions, filtered, selectedId]);
  const activeLogs = active ? logs.filter((log) => log.extensionId === active.id) : [];

  return (
    <ModalBackdrop onClose={onClose} label="Extensions">
      <section className="modal-pane extensions-view" aria-label="Extensions">
        <h1 className="modal-pane-srhead">Extensions</h1>
        <nav className="modal-rail" aria-label="Extension categories">
          <div className="modal-rail-title">Extensions</div>
          {CATEGORIES.map((entry) => {
            const isActive = category === entry.id;
            return (
              <button
                type="button"
                key={entry.id}
                className={isActive ? "modal-rail-item is-active" : "modal-rail-item"}
                onClick={() => setCategory(entry.id)}
              >
                <span>{entry.label}</span>
                <span className="modal-rail-count mono">{counts[entry.id]}</span>
              </button>
            );
          })}
        </nav>
        <section className="modal-list">
          <div className="modal-list-header">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search extensions…"
              aria-label="Search extensions"
            />
          </div>
          <div className="modal-list-rows">
            {filtered.map((extension) => (
              <ExtensionRow
                key={extension.id}
                extension={extension}
                selected={active?.id === extension.id}
                onSelect={() => setSelectedId(extension.id)}
              />
            ))}
            {filtered.length === 0 ? <div className="modal-list-empty">No extensions match.</div> : null}
          </div>
        </section>
        <section className="modal-detail" aria-label="Extension detail">
          <div className="modal-detail-header">
            <span className="modal-detail-title">{active?.name ?? "Extensions"}</span>
            <button type="button" className="modal-close" aria-label="Close" title="Close" onClick={onClose}>
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="modal-detail-body">
            {active ? (
              <ExtensionDetail
                extension={active}
                logs={activeLogs}
                pending={toggleMutation.isPending}
                onToggle={() => toggleMutation.mutate({ extensionId: active.id, enabled: !active.enabled })}
              />
            ) : (
              <div className="loading-panel">No extension selected</div>
            )}
          </div>
        </section>
      </section>
    </ModalBackdrop>
  );
}

interface ModalBackdropProps {
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}

export function ModalBackdrop({ onClose, label, children }: ModalBackdropProps): React.JSX.Element {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <div className="modal-shell" onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

interface ExtensionRowProps {
  extension: Extension;
  selected: boolean;
  onSelect: () => void;
}

function ExtensionRow({ extension, selected, onSelect }: ExtensionRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={selected ? "ext-row is-selected" : "ext-row"}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <ExtensionIcon extension={extension} size={36} />
      <div className="ext-row-body">
        <div className="ext-row-title">
          <span className="ext-row-name">{extension.name}</span>
          {extension.enabled ? <span className="chip add">Enabled</span> : null}
        </div>
        <div className="ext-row-desc">{extension.description}</div>
        <div className="ext-row-meta">
          <span className="mono">{extension.id}</span>
          <span>·</span>
          <span>{describeKind(kindOf(extension))}</span>
        </div>
      </div>
    </button>
  );
}

interface ExtensionDetailProps {
  extension: Extension;
  logs: ExtensionLog[];
  pending: boolean;
  onToggle: () => void;
}

function ExtensionDetail({ extension, logs, pending, onToggle }: ExtensionDetailProps): React.JSX.Element {
  return (
    <article className="ext-detail">
      <header className="ext-detail-head">
        <ExtensionIcon extension={extension} size={64} />
        <div className="ext-detail-head-body">
          <h2 className="ext-detail-title">{extension.name}</h2>
          <div className="ext-detail-meta">
            <span className="mono">{extension.id}</span>
            <span>·</span>
            <span>{describeKind(kindOf(extension))}</span>
            <span>·</span>
            <span>{extension.enabled ? "Enabled" : "Disabled"}</span>
          </div>
          <div className="ext-detail-actions">
            <button
              type="button"
              className={extension.enabled ? "secondary-button" : "primary-button"}
              disabled={pending}
              onClick={onToggle}
            >
              {extension.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        </div>
      </header>

      <section className="ext-detail-section">
        <h3 className="ext-detail-section-title">Overview</h3>
        <p className="ext-detail-text">{extension.description}</p>
      </section>

      <section className="ext-detail-section">
        <h3 className="ext-detail-section-title">Capabilities</h3>
        {extension.capabilities.length > 0 ? (
          <div className="ext-detail-chips">
            {extension.capabilities.map((capability) => (
              <span className="chip" key={capability}>{capability}</span>
            ))}
          </div>
        ) : (
          <p className="ext-detail-text muted">No capabilities declared.</p>
        )}
      </section>

      <section className="ext-detail-section">
        <h3 className="ext-detail-section-title">Activation</h3>
        <div className="ext-detail-card">
          Activates on files matching{" "}
          {extension.activationGlobs.map((glob, index) => (
            <span key={glob}>
              {index > 0 ? " · " : null}
              <code className="ext-detail-code">{glob}</code>
            </span>
          ))}
          {extension.activationGlobs.length === 0 ? <em>any file</em> : null}
          {extension.command ? (
            <>
              <br />
              Command:{" "}
              <code className="ext-detail-code">
                {extension.command.program}
                {extension.command.args && extension.command.args.length > 0
                  ? " " + extension.command.args.join(" ")
                  : ""}
              </code>
            </>
          ) : null}
        </div>
      </section>

      <section className="ext-detail-section">
        <h3 className="ext-detail-section-title">Logs</h3>
        {logs.length === 0 ? (
          <p className="ext-detail-text muted">No log entries yet.</p>
        ) : (
          <div className="ext-detail-log">
            {logs.map((log) => (
              <div className="ext-detail-log-row" key={log.id}>
                <span className={`log-level ${log.level}`}>{log.level}</span>
                <span className="ext-detail-log-message">{log.message}</span>
                <span className="ext-detail-log-time mono">{formatDate(log.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}

interface ExtensionIconProps {
  extension: Extension;
  size: number;
}

function ExtensionIcon({ extension, size }: ExtensionIconProps): React.JSX.Element {
  const palette = paletteFor(extension.id);
  return (
    <div
      className="ext-icon"
      style={{
        width: size,
        height: size,
        background: palette.bg,
        fontSize: Math.round(size * 0.36)
      }}
      aria-hidden="true"
    >
      {glyphFor(extension.name)}
    </div>
  );
}

function kindOf(extension: Extension): ExtensionKind {
  const id = extension.id.toLowerCase();
  if (id.includes("lint") || id.includes("prettier") || id.includes("biome") || id.includes("format")) {
    return "linter";
  }
  if (id.includes("review") || extension.capabilities.includes("review")) {
    return "review";
  }
  if (
    extension.capabilities.some((capability) =>
      capability === "diagnostics" || capability === "definition" || capability === "hover" || capability === "symbols"
    )
  ) {
    return "language";
  }
  return "other";
}

function describeKind(kind: ExtensionKind): string {
  switch (kind) {
    case "language":
      return "Language server";
    case "linter":
      return "Linter / formatter";
    case "review":
      return "Review tool";
    default:
      return "Extension";
  }
}

function countByCategory(extensions: Extension[]): Record<string, number> {
  const counts: Record<string, number> = {
    all: extensions.length,
    enabled: 0,
    disabled: 0,
    language: 0,
    linter: 0,
    review: 0
  };
  for (const extension of extensions) {
    counts[extension.enabled ? "enabled" : "disabled"] += 1;
    const kind = kindOf(extension);
    if (kind in counts) {
      counts[kind] += 1;
    }
  }
  return counts;
}

function filterExtensions(extensions: Extension[], category: (typeof CATEGORIES)[number]["id"], query: string): Extension[] {
  const needle = query.trim().toLowerCase();
  return extensions.filter((extension) => {
    if (category === "enabled" && !extension.enabled) {
      return false;
    }
    if (category === "disabled" && extension.enabled) {
      return false;
    }
    if (category !== "all" && category !== "enabled" && category !== "disabled") {
      if (kindOf(extension) !== category) {
        return false;
      }
    }
    if (!needle) {
      return true;
    }
    return (
      extension.name.toLowerCase().includes(needle) ||
      extension.id.toLowerCase().includes(needle) ||
      extension.description.toLowerCase().includes(needle)
    );
  });
}

const PALETTES = [
  { bg: "oklch(0.55 0.15 25)" },
  { bg: "oklch(0.55 0.14 250)" },
  { bg: "oklch(0.6 0.15 75)" },
  { bg: "oklch(0.5 0.12 200)" },
  { bg: "oklch(0.5 0.18 280)" },
  { bg: "oklch(0.55 0.13 145)" },
  { bg: "oklch(0.65 0.12 200)" },
  { bg: "oklch(0.55 0.18 30)" }
];

function paletteFor(seed: string): { bg: string } {
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
