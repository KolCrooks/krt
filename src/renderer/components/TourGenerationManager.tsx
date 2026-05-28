import { useEffect } from "react";
import { krtClient } from "../api/client.js";
import { useUiStore } from "../store/uiStore.js";

/**
 * A single, always-mounted listener that applies AI tour generation progress to
 * the owning tab — independent of which view (or tab) is currently on screen.
 *
 * Generation runs as a long-lived main-process operation; the per-view hook only
 * starts it and records the operation id on the tab. Routing progress here means
 * streamed chapters keep flowing into the store (and stay visible) even when the
 * tour/storyboard view unmounts because the reviewer switched tabs or views.
 */
export function TourGenerationManager(): null {
  const setTour = useUiStore((state) => state.setTour);
  const setTourProgress = useUiStore((state) => state.setTourProgress);
  const setTourOperation = useUiStore((state) => state.setTourOperation);

  useEffect(() => {
    return krtClient.operations.onProgress((progress) => {
      const tab = useUiStore.getState().tabs.find((candidate) => candidate.tourOperationId === progress.operationId);
      if (!tab) {
        return;
      }
      setTourProgress(tab.key, progress);
      // Stream chapters into the store as they arrive.
      if (progress.tour) {
        setTour(tab.key, progress.tour);
      }
      if (progress.done) {
        if (!progress.cancelled && progress.phase === "complete") {
          void krtClient.ai
            .getCachedTour({
              repository: tab.bundle.detail.repository,
              number: tab.bundle.detail.number,
              headSha: tab.bundle.detail.headSha
            })
            .then((cachedTour) => {
              if (cachedTour) {
                setTour(tab.key, cachedTour);
              }
            });
        }
        // Clear the in-flight marker; tourProgress is retained so a failed or
        // cancelled run can still surface its message in the view.
        setTourOperation(tab.key, null);
      }
    });
  }, [setTour, setTourOperation, setTourProgress]);

  return null;
}
