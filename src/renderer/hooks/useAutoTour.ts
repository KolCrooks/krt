import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { krtClient } from "../api/client.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

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
 * Drives AI tour generation for a PR tab. The in-flight operation and its
 * progress live on the tab in the store (not in this hook), so streaming keeps
 * running and stays visible while the reviewer switches tabs or views — the
 * always-mounted TourGenerationManager applies progress regardless of which
 * view is on screen. This hook only auto-triggers generation and reads state.
 */
export function useAutoTour(tab: PrTab): UseAutoTourResult {
  const setTour = useUiStore((state) => state.setTour);
  const setTourOperation = useUiStore((state) => state.setTourOperation);
  const setTourProgress = useUiStore((state) => state.setTourProgress);
  const triggeredHeadSha = useRef<string | null>(null);

  const operationId = tab.tourOperationId;
  const progress = tab.tourProgress;

  const generateMutation = useMutation<Awaited<ReturnType<typeof krtClient.ai.startTourGeneration>>, unknown, boolean>({
    mutationFn: (force) =>
      krtClient.ai.startTourGeneration({
        pullRequest: tab.bundle.detail,
        changedFiles: tab.bundle.changedFiles,
        timeline: tab.bundle.timeline,
        reviewThreads: tab.bundle.reviewThreads,
        checks: tab.bundle.checks,
        force
      }),
    onMutate: (force) => {
      if (force) {
        setTour(tab.key, null);
      }
      setTourProgress(tab.key, null);
    },
    onSuccess: (result) => {
      if (result.cachedTour) {
        setTour(tab.key, result.cachedTour);
        setTourOperation(tab.key, null);
        setTourProgress(tab.key, {
          operationId: result.operationId,
          phase: "complete",
          message: "AI tour loaded from cache",
          percent: 100,
          done: true,
          cancelled: false
        });
        return;
      }
      setTourOperation(tab.key, result.operationId);
      void krtClient.operations.progressSnapshot({ operationId: result.operationId }).then((snapshot) => {
        if (snapshot) {
          setTourProgress(tab.key, snapshot);
        }
      });
    }
  });

  // Auto-trigger once per headSha when no tour is present and none is generating.
  useEffect(() => {
    if (tab.tour || tab.tourOperationId) {
      return;
    }
    if (triggeredHeadSha.current === tab.bundle.detail.headSha) {
      return;
    }
    if (generateMutation.isPending) {
      return;
    }
    triggeredHeadSha.current = tab.bundle.detail.headSha;
    generateMutation.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fires only on identity / mount changes below
  }, [tab.bundle.detail.headSha, tab.tour, tab.tourOperationId]);

  const isGenerating = generateMutation.isPending || Boolean(operationId && (!progress || !progress.done));
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
      generateMutation.mutate(true);
    },
    cancel: () => {
      if (operationId) {
        void krtClient.operations.cancel({ operationId });
      }
    }
  };
}
