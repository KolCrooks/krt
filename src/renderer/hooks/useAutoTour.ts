import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { krtClient } from "../api/client.js";
import type { AgentActivity } from "../../shared/schemas.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

export interface UseAutoTourResult {
  isGenerating: boolean;
  hasFailed: boolean;
  message: string | null;
  // Epoch ms when generation started, for showing elapsed "thinking" time.
  // (There is no turn cap, so progress can no longer be a percentage.)
  startedAt: number | null;
  operationId: string | null;
  activity: AgentActivity[];
  // AI review reads the checked-out code, so generation is deferred until the PR
  // is checked out (managed mode) rather than failing. The view offers a button.
  needsCheckout: boolean;
  isCheckingOut: boolean;
  checkout: () => void;
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
  const setCheckout = useUiStore((state) => state.setCheckout);
  const triggeredHeadSha = useRef<string | null>(null);

  const operationId = tab.tourOperationId;
  const progress = tab.tourProgress;
  const needsCheckout = tab.mode !== "managed";

  // Check out the PR so the agent can read the code. Completion flips the tab to
  // managed mode (handled by CheckoutBanner's progress subscription), which makes
  // the auto-trigger effect below start generation automatically.
  const checkoutMutation = useMutation({
    mutationFn: () =>
      krtClient.repos.checkoutPullRequest({
        repository: tab.bundle.detail.repository,
        number: tab.bundle.detail.number,
        headRef: tab.bundle.detail.headRef,
        baseRef: tab.bundle.detail.baseRef,
        headSha: tab.bundle.detail.headSha
      }),
    onMutate: () => {
      setCheckout(tab.key, { state: "checking", message: "Checking out the branch to generate the tour", percent: 0, operationId: null });
    },
    onSuccess: (result) => {
      setCheckout(tab.key, { operationId: result.operationId });
    },
    onError: (error) => {
      setCheckout(tab.key, {
        state: "idle",
        message: error instanceof Error ? error.message : "Checkout failed",
        percent: null,
        operationId: null
      });
    }
  });
  const isCheckingOut = tab.checkout.state === "checking" || checkoutMutation.isPending;

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
      setTourOperation(tab.key, null);
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
          if (snapshot.done) {
            setTourOperation(tab.key, null);
          }
        }
      });
    }
  });

  // Auto-trigger once per headSha when no tour is present and none is generating.
  // Deferred until the PR is checked out (managed) — generation reads the code,
  // so before checkout we surface a button instead of failing. Once checkout
  // flips the tab to managed, tab.mode changes and this effect fires generation.
  useEffect(() => {
    if (tab.mode !== "managed") {
      return;
    }
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
  }, [tab.bundle.detail.headSha, tab.mode, tab.tour, tab.tourOperationId]);

  const hasFailed =
    generateMutation.isError || Boolean(progress?.done && (progress.cancelled || progress.phase === "failed"));
  const isStartingGeneration = generateMutation.isPending && !tab.tour;
  const isGenerating = !hasFailed && (isStartingGeneration || Boolean(operationId && (!progress || !progress.done)));

  return {
    isGenerating,
    // While checkout is needed/running, defer the "failed" state to the checkout UI.
    hasFailed: hasFailed && !needsCheckout && !isCheckingOut,
    message: progress?.message ?? (isGenerating ? "Preparing AI tour" : null),
    startedAt: tab.tourStartedAt ?? null,
    operationId,
    activity: tab.tourActivity ?? [],
    needsCheckout,
    isCheckingOut,
    checkout: () => {
      if (!isCheckingOut) {
        checkoutMutation.mutate();
      }
    },
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
