import { krtClient } from "../api/client.js";
import type { AgentActivity, ChatMessage, OperationProgress } from "../../shared/schemas.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

/**
 * Apply a terminal (done) chat-operation progress event to the tab: commit the
 * answer, surface a failure (a user cancel is silent), and clear the in-flight
 * marker. Shared by TourChatManager (live events) and the send-time snapshot
 * catch-up below, so a completion that lands before the listener is wired up is
 * not lost.
 */
export function applyChatTerminalProgress(tabKey: string, progress: OperationProgress): void {
  const { appendChatMessage, setChatError, resetChatActivity, setChatOperation } = useUiStore.getState();
  if (!progress.cancelled && progress.phase === "complete" && progress.answer) {
    appendChatMessage(tabKey, { role: "assistant", content: progress.answer });
  } else if (progress.phase === "failed") {
    setChatError(tabKey, progress.message || "The chat request failed.");
  }
  resetChatActivity(tabKey);
  setChatOperation(tabKey, null);
}

export interface UseTourChatResult {
  messages: ChatMessage[];
  // Live trace of the agent working on the current (unanswered) question.
  activity: AgentActivity[];
  isResponding: boolean;
  error: string | null;
  /** Send a question. No-op when empty, while responding, or with no tour. */
  send: (text: string) => void;
  cancel: () => void;
}

/**
 * Drives a conversation with the agent about the generated tour for a PR tab.
 * Like useAutoTour, the in-flight operation lives on the tab in the store so the
 * always-mounted TourChatManager can apply streamed progress regardless of which
 * view is on screen; this hook starts requests and reads state.
 */
export function useTourChat(tab: PrTab): UseTourChatResult {
  const appendChatMessage = useUiStore((state) => state.appendChatMessage);
  const setChatOperation = useUiStore((state) => state.setChatOperation);
  const resetChatActivity = useUiStore((state) => state.resetChatActivity);
  const setChatError = useUiStore((state) => state.setChatError);

  const messages = tab.chatMessages ?? [];
  const operationId = tab.chatOperationId ?? null;
  const isResponding = Boolean(operationId);

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || isResponding || !tab.tour) {
      return;
    }
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    appendChatMessage(tab.key, { role: "user", content: trimmed });
    resetChatActivity(tab.key);
    setChatError(tab.key, null);

    void krtClient.ai
      .startTourChat({
        pullRequest: tab.bundle.detail,
        changedFiles: tab.bundle.changedFiles,
        tour: tab.tour,
        messages: nextMessages
      })
      .then((result) => {
        setChatOperation(tab.key, result.operationId);
        // Catch up in case the operation already finished before the progress
        // listener could match it (mirrors useAutoTour's snapshot guard).
        void krtClient.operations.progressSnapshot({ operationId: result.operationId }).then((snapshot) => {
          if (snapshot?.done) {
            applyChatTerminalProgress(tab.key, snapshot);
          }
        });
      })
      .catch((error: unknown) => {
        setChatError(tab.key, error instanceof Error ? error.message : "Failed to start the chat.");
      });
  };

  const cancel = (): void => {
    if (operationId) {
      void krtClient.operations.cancel({ operationId });
    }
  };

  return {
    messages,
    activity: tab.chatActivity ?? [],
    isResponding,
    error: tab.chatError ?? null,
    send,
    cancel
  };
}
