import { useMutation } from "@tanstack/react-query";
import { Ban, Code2, GitBranch, RefreshCw, X } from "lucide-react";
import { useEffect } from "react";
import { krtClient } from "../../api/client.js";
import type { PrTab } from "../../store/uiStore.js";
import { useUiStore } from "../../store/uiStore.js";

interface CheckoutBannerProps {
  tab: PrTab;
}

export function CheckoutBanner({ tab }: CheckoutBannerProps): React.JSX.Element | null {
  const setCheckout = useUiStore((state) => state.setCheckout);
  const dismissCheckoutBanner = useUiStore((state) => state.dismissCheckoutBanner);
  const setTabMode = useUiStore((state) => state.setTabMode);
  const detail = tab.bundle.detail;

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
        setCheckout(tab.key, { message: progress.message, percent: progress.percent ?? null });
        if (progress.done && !progress.cancelled && progress.phase === "complete") {
          setTabMode(tab.key, "managed");
          setCheckout(tab.key, { state: "checked" });
        }
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
      setCheckout(tab.key, { message: progress.message, percent: progress.percent ?? null });
      if (progress.done && !progress.cancelled && progress.phase === "complete") {
        setTabMode(tab.key, "managed");
        setCheckout(tab.key, { state: "checked" });
      }
    });
  }, [setCheckout, setTabMode, tab.checkout.operationId, tab.key]);

  if (tab.checkout.state === "checked" || tab.checkout.dismissed || tab.mode === "managed") {
    return null;
  }

  const isChecking = tab.checkout.state === "checking" || checkoutMutation.isPending;

  return (
    <div className="checkout-banner" role="status">
      <span className="checkout-banner-icon" aria-hidden="true">
        <Code2 size={11} />
      </span>
      <span className="checkout-banner-text">
        {isChecking ? (
          <>
            Checking out <span className="mono">{detail.headRef}</span>… enables rust-analyzer, jump-to-definition, and refactors.
          </>
        ) : (
          <>
            You're browsing the diff. <strong>Check out the branch</strong> to enable rust-analyzer, jump-to-definition, and refactors — review works fine without it.
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
