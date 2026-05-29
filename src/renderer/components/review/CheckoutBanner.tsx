import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, Code2, GitBranch, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect } from "react";
import { krtClient } from "../../api/client.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";
import type { OperationProgress } from "../../../shared/schemas.js";

interface CheckoutBannerProps {
  tab: PrTab;
}

export function CheckoutBanner({ tab }: CheckoutBannerProps): React.JSX.Element | null {
  const setCheckout = useUiStore((state) => state.setCheckout);
  const dismissCheckoutBanner = useUiStore((state) => state.dismissCheckoutBanner);
  const setTabMode = useUiStore((state) => state.setTabMode);
  const detail = tab.bundle.detail;
  const applyProgress = useCallback(
    (progress: OperationProgress) => {
      setCheckout(tab.key, { message: progress.message, percent: progress.percent ?? null });
      if (progress.done && !progress.cancelled && progress.phase === "complete") {
        setTabMode(tab.key, "managed");
        setCheckout(tab.key, { state: "checked", message: progress.message, percent: 100, operationId: null });
        return;
      }
      if (progress.done && (progress.cancelled || progress.phase === "failed")) {
        setCheckout(tab.key, {
          state: "idle",
          message: checkoutFailureMessage(progress),
          percent: null,
          operationId: null
        });
      }
    },
    [setCheckout, setTabMode, tab.key]
  );
  const checkoutStatus = useQuery({
    queryKey: ["checkout-status", detail.repository.fullName, detail.headSha],
    enabled: tab.mode !== "managed" && tab.checkout.state !== "checking",
    queryFn: () =>
      krtClient.repos.selectMode({
        repository: detail.repository,
        preferredMode: "auto",
        headSha: detail.headSha
      })
  });

  const checkoutMutation = useMutation({
    mutationFn: () =>
      krtClient.repos.checkoutPullRequest({
        repository: detail.repository,
        number: detail.number,
        headRef: detail.headRef,
        baseRef: detail.baseRef,
        headSha: detail.headSha
      }),
    onMutate: () => {
      setCheckout(tab.key, { state: "checking", message: "Starting checkout", percent: 0, operationId: null });
    },
    onSuccess: (result) => {
      setCheckout(tab.key, { operationId: result.operationId });
      void krtClient.operations.progressSnapshot({ operationId: result.operationId }).then((progress) => {
        if (!progress) {
          return;
        }
        applyProgress(progress);
      });
    },
    onError: (error) => {
      setCheckout(tab.key, {
        state: "idle",
        message: errorMessage(error),
        percent: null,
        operationId: null
      });
    }
  });

  useEffect(() => {
    const opId = tab.checkout.operationId;
    if (!opId) {
      return undefined;
    }
    return krtClient.operations.onProgress((progress) => {
      if (progress.operationId !== opId) {
        return;
      }
      applyProgress(progress);
    });
  }, [applyProgress, tab.checkout.operationId]);

  useEffect(() => {
    if (checkoutStatus.data?.mode !== "managed") {
      return;
    }
    setTabMode(tab.key, "managed");
    setCheckout(tab.key, { state: "checked", message: checkoutStatus.data.reason, percent: 100 });
  }, [checkoutStatus.data?.mode, checkoutStatus.data?.reason, setCheckout, setTabMode, tab.key]);

  if (tab.checkout.state === "checked" || tab.checkout.dismissed || tab.mode === "managed") {
    return null;
  }

  const isChecking = tab.checkout.state === "checking" || checkoutMutation.isPending;

  return (
    <div className="checkout-banner" role="status">
      <span className="checkout-banner-icon" aria-hidden="true">
        {!isChecking && tab.checkout.message ? <AlertTriangle size={11} /> : <Code2 size={11} />}
      </span>
      <span className="checkout-banner-text">
        {isChecking ? (
          <>
            {tab.checkout.message ?? (
              <>
                Checking out <span className="mono">{detail.headRef}</span> enables rust-analyzer, jump-to-definition, and refactors.
              </>
            )}
          </>
        ) : tab.checkout.message ? (
          <>
            <strong>{tab.checkout.message}</strong> Review still works in diff mode.
          </>
        ) : (
          <>
            You're browsing the diff. <strong>Check out the branch</strong> to enable rust-analyzer, jump-to-definition, and refactors - review works fine without it.
          </>
        )}
      </span>
      {isChecking ? (
        <button
          type="button"
          className="secondary-button"
          disabled={!tab.checkout.operationId}
          onClick={() => {
            if (tab.checkout.operationId) {
              void krtClient.operations.cancel({ operationId: tab.checkout.operationId });
            }
          }}
        >
          <Ban size={12} aria-hidden="true" />
          Cancel
        </button>
      ) : (
        <button type="button" className="primary-button" onClick={() => checkoutMutation.mutate()}>
          <GitBranch size={12} aria-hidden="true" />
          Check out branch
        </button>
      )}
      {!isChecking ? (
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss checkout banner"
          onClick={() => dismissCheckoutBanner(tab.key)}
        >
          <X size={11} aria-hidden="true" />
        </button>
      ) : null}
      {isChecking ? <RefreshCw className="spin checkout-banner-spinner" size={11} aria-hidden="true" /> : null}
    </div>
  );
}

function checkoutFailureMessage(progress: OperationProgress): string {
  if (progress.cancelled) {
    return progress.message;
  }

  const errorLine = progress.error
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
    ?.replace(/^fatal:\s*/i, "");
  return errorLine ? `${progress.message}: ${errorLine}` : progress.message;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Managed checkout failed";
}
