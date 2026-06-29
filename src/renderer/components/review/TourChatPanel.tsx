import { Ban, Bot, MessageCircle, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTourChat } from "../../hooks/useTourChat.js";
import { renderMarkdown } from "../../lib/markdown.js";
import type { PrTab } from "../../store/uiStore.js";
import { AgentActivityFeed } from "./AgentActivityFeed.js";

interface TourChatPanelProps {
  tab: PrTab;
}

/**
 * A collapsible panel for chatting with the agent about the generated tour. The
 * conversation, in-flight operation, and live working trace all live on the tab
 * in the store (applied by TourChatManager), so the thread survives switching
 * chapters, views, and tabs.
 */
export function TourChatPanel({ tab }: TourChatPanelProps): React.JSX.Element | null {
  const chat = useTourChat(tab);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the latest message / working trace in view as the conversation grows.
  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    }
  }, [open, chat.messages.length, chat.activity.length, chat.isResponding]);

  if (!tab.tour) {
    return null;
  }

  const submit = (): void => {
    if (!draft.trim() || chat.isResponding) {
      return;
    }
    chat.send(draft);
    setDraft("");
  };

  if (!open) {
    return (
      <button type="button" className="tour-chat-fab" onClick={() => setOpen(true)}>
        <MessageCircle size={15} aria-hidden="true" />
        Ask about this tour
        {chat.messages.length > 0 ? <span className="tour-chat-fab-count">{chat.messages.length}</span> : null}
      </button>
    );
  }

  return (
    <section className="tour-chat-panel" aria-label="Chat about the tour">
      <header className="tour-chat-panel-header">
        <span className="tour-chat-panel-title">
          <Bot size={15} aria-hidden="true" />
          Ask about this tour
        </span>
        <button type="button" className="icon-button" aria-label="Close chat" onClick={() => setOpen(false)}>
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="tour-chat-thread">
        {chat.messages.length === 0 && !chat.isResponding ? (
          <p className="tour-chat-empty">
            Ask about the chapters, risks, or how the pieces fit together. The agent can dig into the diff and code to
            answer.
          </p>
        ) : null}
        {chat.messages.map((message, index) => (
          <div key={index} className={`tour-chat-message tour-chat-${message.role}`}>
            {message.role === "assistant" ? (
              <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
            ) : (
              <span className="tour-chat-text">{message.content}</span>
            )}
          </div>
        ))}
        {chat.isResponding ? <AgentActivityFeed entries={chat.activity} active /> : null}
        {chat.error ? <p className="tour-chat-error">{chat.error}</p> : null}
        <div ref={endRef} />
      </div>

      <div className="tour-chat-composer">
        <textarea
          className="tour-chat-input"
          rows={2}
          placeholder="Ask about this tour…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {chat.isResponding ? (
          <button type="button" className="secondary-button tour-chat-send" onClick={chat.cancel}>
            <Ban size={14} aria-hidden="true" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="primary-button tour-chat-send"
            disabled={!draft.trim()}
            onClick={submit}
          >
            <Send size={14} aria-hidden="true" />
            Send
          </button>
        )}
      </div>
    </section>
  );
}
