import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { krtClient } from "../api/client.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";
import type { OperationProgress } from "../../shared/schemas.js";

export interface UseAutoTourResult {
  isGenerating: boolean;
  hasFailed: boolean;
  message: string | null;
  percent: number | null;
  operationId: string | null;
  regenerate: () => void;
  cancel: () => void;
}

/**
 * Drives AI tour generation for a PR tab. Auto-triggers a fetch when the tab
 * has no cached tour, and listens to operation progress until it completes.
 */
export function useAutoTour(tab: PrTab): UseAutoTourResult {
  const setTour = useUiStore((state) => state.setTour);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const triggeredHeadSha = useRef<string | null>(null);

  const generateMutation = useMutation({
    mutationFn: () =>
      krtClient.ai.startTourGeneration({
        pullRequest: tab.bundle.detail,
        changedFiles: tab.bundle.changedFiles,
        timeline: tab.bundle.timeline,
        reviewThreads: tab.bundle.reviewThreads,
        checks: tab.bundle.checks
      }),
    onMutate: () => {
      setOperationId(null);
      setProgress(null);
    },
    onSuccess: (result) => {
      setOperationId(result.operationId);
      if (result.cachedTour) {
        setTour(tab.key, result.cachedTour);
        setProgress({
          operationId: result.operationId,
          phase: "complete",
          message: "AI tour loaded from cache",
          percent: 100,
          done: true,
          cancelled: false
        });
        return;
      }
      void krtClient.operations.progressSnapshot({ operationId: result.operationId }).then((snapshot) => {
        if (snapshot) {
          setProgress(snapshot);
        }
      });
    }
  });

  // Auto-trigger once per headSha when no tour is present yet.
  useEffect(() => {
    if (tab.tour) {
      return;
    }
    if (triggeredHeadSha.current === tab.bundle.detail.headSha) {
      return;
    }
    if (generateMutation.isPending || operationId) {
      return;
    }
    triggeredHeadSha.current = tab.bundle.detail.headSha;
    generateMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fires only on identity / mount changes below
  }, [tab.bundle.detail.headSha, tab.tour]);

  // Listen to operation progress; rehydrate from cache on completion.
  useEffect(() => {
    if (!operationId) {
      return undefined;
    }
    return krtClient.operations.onProgress((nextProgress) => {
      if (nextProgress.operationId !== operationId) {
        return;
      }
      setProgress(nextProgress);
      if (nextProgress.done && !nextProgress.cancelled && nextProgress.phase === "complete") {
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
    });
  }, [operationId, setTour, tab.bundle.detail.headSha, tab.bundle.detail.number, tab.bundle.detail.repository, tab.key]);

  const isGenerating =
    generateMutation.isPending || Boolean(operationId && (!progress || !progress.done));
  const hasFailed =
    generateMutation.isError || Boolean(progress?.done && (progress.cancelled || progress.phase === "failed"));

  return {
    isGenerating,
    hasFailed,
    message: progress?.message ?? (isGenerating ? "Preparing AI tour" : null),
    percent: progress?.percent ?? null,
    operationId,
    regenerate: () => {
      triggeredHeadSha.current = tab.bundle.detail.headSha;
      generateMutation.mutate();
    },
    cancel: () => {
      if (operationId) {
        void krtClient.operations.cancel({ operationId });
      }
    }
  };
}
