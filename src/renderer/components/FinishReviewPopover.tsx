import { useMutation } from "@tanstack/react-query";
import { Check, Lightbulb, MessageSquare, X } from "lucide-react";
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
  const removeDraftReviewComment = useUiStore((state) => state.removeDraftReviewComment);
  const clearFinishReview = useUiStore((state) => state.clearFinishReview);
  const body = tab.finish.body;
  const comments = tab.finish.comments ?? [];
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
        comments: comments.map(({ id: _id, ...comment }) => comment)
      }),
    onSuccess: () => {
      clearFinishReview(tab.key);
      setSubmitted(true);
    }
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
        {comments.length > 0 ? (
          <div className="finish-review-comments" aria-label="Pending review comments">
            <div className="finish-review-comments-head">
              <MessageSquare size={12} aria-hidden="true" />
              <span>{comments.length} pending diff comment{comments.length === 1 ? "" : "s"}</span>
            </div>
            <div className="finish-review-comments-list">
              {comments.map((comment) => (
                <div className="finish-review-comment-row" key={comment.id}>
                  <div>
                    <span className="mono">{formatDraftCommentLocation(comment)}</span>
                    <p>{comment.body}</p>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove comment on ${formatDraftCommentLocation(comment)}`}
                    onClick={() => removeDraftReviewComment(tab.key, comment.id)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
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

function formatDraftCommentLocation(comment: { path: string; line?: number; startLine?: number }): string {
  if (!comment.line) {
    return comment.path;
  }
  if (comment.startLine && comment.startLine !== comment.line) {
    return `${comment.path}:${comment.startLine}-${comment.line}`;
  }
  return `${comment.path}:${comment.line}`;
}
