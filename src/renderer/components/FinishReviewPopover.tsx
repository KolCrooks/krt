import { useMutation } from "@tanstack/react-query";
import { Check, Lightbulb, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { krtClient } from "../api/client.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

interface FinishReviewPopoverProps {
  tab: PrTab;
  onClose: () => void;
}

type ReviewEvent = "comment" | "approve" | "request_changes";

export function FinishReviewPopover({ tab, onClose }: FinishReviewPopoverProps): React.JSX.Element {
  const setFinishBody = useUiStore((state) => state.setFinishBody);
  const body = tab.finish.body;
  const [submitted, setSubmitted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const submitMutation = useMutation({
    mutationFn: (event: ReviewEvent) =>
      krtClient.reviews.submit({
        repository: tab.bundle.detail.repository,
        pullNumber: tab.bundle.detail.number,
        event,
        body,
        commitSha: tab.bundle.detail.headSha,
        comments: []
      }),
    onSuccess: () => setSubmitted(true)
  });

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    const timeout = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    document.addEventListener("keydown", handleKey);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  if (submitted) {
    return (
      <div className="finish-review-popover" ref={ref}>
        <div className="finish-review-success">
          <Check size={18} aria-hidden="true" />
          <span>Review submitted</span>
        </div>
      </div>
    );
  }

  return (
    <div className="finish-review-popover" ref={ref} aria-label="Finish review">
      <header className="finish-review-popover-header">
        <strong>
          <Check size={13} aria-hidden="true" />
          Finish review
        </strong>
        <span>Summarize your verdict below.</span>
      </header>
      <div className="finish-review-popover-body">
        <textarea
          value={body}
          rows={5}
          autoFocus
          placeholder="Leave a summary for the author… (Markdown supported)"
          onChange={(event) => setFinishBody(tab.key, event.target.value)}
          aria-label="Summary"
        />
      </div>
      <footer className="finish-review-popover-footer">
        <span className="finish-review-popover-note">Submits to the author.</span>
        <div className="finish-review-popover-actions">
          <button
            type="button"
            className="finish-review-action"
            disabled={submitMutation.isPending}
            onClick={() => submitMutation.mutate("comment")}
          >
            <MessageSquare size={11} aria-hidden="true" />
            Comment
          </button>
          <button
            type="button"
            className="finish-review-action is-warning"
            disabled={submitMutation.isPending}
            onClick={() => submitMutation.mutate("request_changes")}
          >
            <Lightbulb size={11} aria-hidden="true" />
            Request changes
          </button>
          <button
            type="button"
            className="finish-review-action is-approve"
            disabled={submitMutation.isPending}
            onClick={() => submitMutation.mutate("approve")}
          >
            <Check size={11} aria-hidden="true" />
            Approve
          </button>
        </div>
      </footer>
    </div>
  );
}
