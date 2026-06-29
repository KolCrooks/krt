import { useEffect } from "react";
import { krtClient } from "../api/client.js";
import { applyChatTerminalProgress } from "../hooks/useTourChat.js";
import { useUiStore } from "../store/uiStore.js";

/**
 * A single, always-mounted listener that applies tour-chat progress to the
 * owning tab — independent of which view is on screen, mirroring
 * TourGenerationManager. The agent's working steps stream into chatActivity; the
 * final answer is appended to chatMessages when the operation completes.
 */
export function TourChatManager(): null {
  const appendChatActivity = useUiStore((state) => state.appendChatActivity);

  useEffect(() => {
    return krtClient.operations.onProgress((progress) => {
      const tab = useUiStore.getState().tabs.find((candidate) => candidate.chatOperationId === progress.operationId);
      if (!tab) {
        return;
      }
      if (!progress.done) {
        if (progress.activity) {
          appendChatActivity(tab.key, progress.activity);
        }
        return;
      }
      applyChatTerminalProgress(tab.key, progress);
    });
  }, [appendChatActivity]);

  return null;
}
