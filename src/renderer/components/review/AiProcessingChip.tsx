import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { krtClient } from "../../api/client.js";
import { formatThinkingTime, useThinkingSeconds } from "../../hooks/useThinkingTime.js";
import type { PrTab } from "../../store/uiStore.js";
import { AgentWorkingOverlay } from "./AgentWorkingOverlay.js";

/**
 * A small animated chip pinned to the bottom-right of the review while the AI
 * agent is still working. Inline comments are emitted at the very end of
 * generation, so without this it is hard to tell the agent is still running.
 * Clicking it opens the full activity feed.
 */
export function AiProcessingChip({ tab }: { tab: PrTab }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const operationId = tab.tourOperationId;
  const progress = tab.tourProgress;
  const isGenerating = Boolean(operationId) && !(progress?.done ?? false);
  const activity = tab.tourActivity ?? [];
  const thinkingSeconds = useThinkingSeconds(tab.tourStartedAt ?? null, isGenerating);

  useEffect(() => {
    if (!isGenerating) {
      setOpen(false);
    }
  }, [isGenerating]);

  if (!isGenerating) {
    return null;
  }

  const latest = activity.at(-1)?.text ?? progress?.message ?? "Reviewing the change…";

  return (
    <>
      <button
        type="button"
        className="ai-chip"
        onClick={() => setOpen(true)}
        title="Show AI review progress"
        aria-label="AI review in progress — show details"
      >
        <span className="ai-chip-spinner" aria-hidden="true">
          <Sparkles size={12} />
        </span>
        <span className="ai-chip-label">{latest}</span>
        {thinkingSeconds !== null ? <span className="ai-chip-elapsed">{formatThinkingTime(thinkingSeconds)}</span> : null}
      </button>
      {open ? (
        <AgentWorkingOverlay
          title="Generating AI review"
          message={progress?.message ?? null}
          startedAt={tab.tourStartedAt ?? null}
          activity={activity}
          isGenerating={isGenerating}
          canCancel={Boolean(operationId)}
          onCancel={() => {
            if (operationId) {
              void krtClient.operations.cancel({ operationId });
            }
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
