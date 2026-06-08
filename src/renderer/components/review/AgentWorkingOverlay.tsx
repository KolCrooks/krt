import { Ban, Bot, X } from "lucide-react";
import { useEffect } from "react";
import type { AgentActivity } from "../../../shared/schemas.js";
import { AgentActivityFeed } from "./AgentActivityFeed.js";

interface AgentWorkingOverlayProps {
  title: string;
  message: string | null;
  percent: number | null;
  activity: AgentActivity[];
  isGenerating: boolean;
  canCancel: boolean;
  onCancel: () => void;
  onClose: () => void;
}

/**
 * A modal that surfaces the full "agent working" view — status and the live
 * chat feed — on top of a partially-streamed tour or storyboard, so a reviewer
 * can watch the agent finish without losing the chapters that already arrived.
 */
export function AgentWorkingOverlay({
  title,
  message,
  percent,
  activity,
  isGenerating,
  canCancel,
  onCancel,
  onClose
}: AgentWorkingOverlayProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="agent-overlay" role="dialog" aria-modal="true" aria-label="AI review progress" onClick={onClose}>
      <div className="agent-overlay-panel" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-button agent-overlay-close" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
        <Bot size={22} aria-hidden="true" className={isGenerating ? "spin" : undefined} />
        <h2>{title}</h2>
        <p>{message ?? "Working through the change…"}</p>
        <AgentActivityFeed entries={activity} active={isGenerating} />
        <div className="agent-overlay-footer">
          {isGenerating && canCancel ? (
            <button type="button" className="secondary-button" onClick={onCancel}>
              <Ban size={14} aria-hidden="true" />
              Cancel
            </button>
          ) : null}
          {typeof percent === "number" ? <span className="tour-empty-status">{Math.round(percent)}%</span> : null}
        </div>
      </div>
    </div>
  );
}
