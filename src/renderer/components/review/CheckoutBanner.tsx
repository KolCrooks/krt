import { useMutation, useQuery } from "@tanstack/react-query";
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
    onError: () => {
      setCheckout(tab.key, { state: "idle", operationId: null, message: null, percent: null });
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
      if (progress.done) {
        if (!progress.cancelled && progress.phase === "complete") {
          setTabMode(tab.key, "managed");
          setCheckout(tab.key, { state: "checked" });
        } else if (progress.cancelled) {
          setCheckout(tab.key, { state: "idle", operationId: null, message: null, percent: null });
        }
      }
    });
  }, [setCheckout, setTabMode, tab.checkout.operationId, tab.key]);

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

  const isChecking = tab.checkout.state === "checking" && tab.checkout.operationId !== null;

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
        <button type="button" className="primary-button" disabled={checkoutMutation.isPending} onClick={() => checkoutMutation.mutate()}>
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
