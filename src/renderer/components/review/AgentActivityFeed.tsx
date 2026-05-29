import { Brain, MessageSquare, TriangleAlert, Wrench } from "lucide-react";
import { useEffect, useRef } from "react";
import type { AgentActivity } from "../../../shared/schemas.js";

interface AgentActivityFeedProps {
  entries: AgentActivity[];
  active: boolean;
}

const KIND_META: Record<AgentActivity["kind"], { label: string; Icon: typeof Brain }> = {
  think: { label: "Thinking", Icon: Brain },
  say: { label: "Note", Icon: MessageSquare },
  tool: { label: "Action", Icon: Wrench },
  result: { label: "Result", Icon: TriangleAlert }
};

/**
 * A live chat-style transcript of the review agent at work — its thinking, its
 * notes, and every exploration/tool call — shown while the tour generates.
 * Renders nothing until the agent produces its first step.
 */
export function AgentActivityFeed({ entries, active }: AgentActivityFeedProps): React.JSX.Element | null {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, [entries.length]);

  if (entries.length === 0) {
    return null;
  }

  const recent = entries.slice(-60);
  const start = entries.length - recent.length;
  return (
    <div className="agent-chat" aria-label="Agent activity" aria-live="polite">
      {recent.map((entry, index) => {
        const meta = KIND_META[entry.kind];
        const isLast = index === recent.length - 1;
        const Icon = meta.Icon;
        return (
          <div key={start + index} className={`agent-chat-row agent-chat-${entry.kind}`}>
            <span className="agent-chat-avatar" aria-hidden="true">
              <Icon size={12} />
            </span>
            <div className="agent-chat-bubble">
              <span className="agent-chat-role">{meta.label}</span>
              <span className="agent-chat-text">{entry.text}</span>
            </div>
          </div>
        );
      })}
      {active ? (
        <div className="agent-chat-row agent-chat-typing" aria-hidden="true">
          <span className="agent-chat-avatar">
            <span className="agent-chat-dot" />
          </span>
          <div className="agent-chat-bubble">
            <span className="agent-chat-dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
