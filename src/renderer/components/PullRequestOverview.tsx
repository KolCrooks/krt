import { useMutation } from "@tanstack/react-query";
import {
  Bot,
  Check,
  CheckCircle2,
  ExternalLink,
  GitPullRequestArrow,
  MessageSquare,
  Play,
  RefreshCw
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { krtClient } from "../api/client.js";
import { formatCount, formatDate, statusClass } from "../lib/format.js";
import { renderMarkdown } from "../lib/markdown.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";
import type { ActivityEvent, OperationProgress, ReviewThread } from "../../shared/schemas.js";

interface PullRequestOverviewProps {
  tab: PrTab;
}

export function PullRequestOverview({ tab }: PullRequestOverviewProps): React.JSX.Element {
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const setReviewSubMode = useUiStore((state) => state.setReviewSubMode);
  const updatePrTab = useUiStore((state) => state.updatePrTab);
  const detail = tab.bundle.detail;
  const [refreshProgress, setRefreshProgress] = useState<OperationProgress | null>(null);
  const [refreshOperationId, setRefreshOperationId] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("just now");

  const refreshMutation = useMutation({
    onMutate: () => {
      setRefreshProgress(null);
      setRefreshOperationId(null);
    },
    mutationFn: () =>
      krtClient.pullRequests.startRefresh({
        repository: detail.repository,
        number: detail.number,
        mode: tab.mode
      }),
    onSuccess: (result) => {
      setRefreshOperationId(result.operationId);
      void krtClient.operations.progressSnapshot({ operationId: result.operationId }).then((progress) => {
        if (progress) {
          setRefreshProgress(progress);
        }
      });
    }
  });

  useEffect(() => {
    if (!refreshOperationId) {
      return undefined;
    }
    return krtClient.operations.onProgress((progress) => {
      if (progress.operationId === refreshOperationId) {
        setRefreshProgress(progress);
      }
    });
  }, [refreshOperationId]);

  useEffect(() => {
    if (!refreshOperationId || !refreshProgress?.done || refreshProgress.cancelled || refreshProgress.phase !== "complete") {
      return undefined;
    }
    let active = true;
    void krtClient.pullRequests.refreshResult({ operationId: refreshOperationId }).then((bundle) => {
      if (!active || !bundle) {
        return;
      }
      updatePrTab(bundle);
      setRefreshOperationId(null);
      setRefreshProgress(null);
      setLastSync("just now");
    });
    return () => {
      active = false;
    };
  }, [refreshOperationId, refreshProgress?.cancelled, refreshProgress?.done, refreshProgress?.phase, updatePrTab]);

  const refreshActive = refreshMutation.isPending || (Boolean(refreshOperationId) && (!refreshProgress || !refreshProgress.done));
  const totalFiles = tab.bundle.changedFiles.length || detail.changedFileCount;
  const stateChip = stateBadge(detail.state, detail.draft);
  const reviewerSummary = detail.reviewers.slice(0, 4);

  return (
    <main className="view overview-view">
      <div className="overview-scroll">
        <div className="overview-grid">
          <div className="overview-main">
            {/* link + state + refresh */}
            <div className="pr-toprow">
              <a
                className="pr-link mono"
                href={detail.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open on the source host"
              >
                <span>{detail.repository.fullName} #{detail.number}</span>
                <ExternalLink size={9} aria-hidden="true" />
              </a>
              {stateChip}
              <span className="pr-toprow-spacer" />
              <span className="pr-sync">Synced {lastSync}</span>
              <button
                type="button"
                className="icon-button pr-refresh"
                aria-label="Refresh PR"
                title="Refresh PR"
                disabled={refreshActive}
                onClick={() => refreshMutation.mutate()}
              >
                <RefreshCw className={refreshActive ? "spin" : undefined} size={13} aria-hidden="true" />
              </button>
            </div>

            {/* title */}
            <h1 className="pr-title">{detail.title}</h1>

            {/* author / branch / counts */}
            <div className="pr-meta">
              <Avatar login={detail.author.login} avatarUrl={detail.author.avatarUrl} />
              <span className="pr-meta-author">{detail.author.login}</span>
              <span className="pr-meta-branch mono">{detail.headRef || detail.headSha.slice(0, 7)}</span>
              <span className="pr-meta-arrow">→</span>
              <span className="pr-meta-branch mono">{detail.baseRef}</span>
              <span className="pr-meta-spacer" />
              <span className="mono pr-meta-stats">
                <span className="diff-counts-add">+{detail.additions}</span>{" "}
                <span className="diff-counts-del">−{detail.deletions}</span>
                {" · "}
                {totalFiles} files
              </span>
            </div>

            {/* description */}
            <section className="pr-card">
              <header className="pr-card-header">
                <span>Description</span>
                <button
                  type="button"
                  className="secondary-button pr-card-action"
                  onClick={() => {
                    setTabViewMode(tab.key, "review");
                    setReviewSubMode(tab.key, "tour");
                  }}
                >
                  <Bot size={11} aria-hidden="true" />
                  Open tour
                </button>
              </header>
              <div
                className="markdown pr-card-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.body || "_No description provided._") }}
              />
            </section>

            <ActivitySection tab={tab} />
            <ReviewThreadsPanel tab={tab} />
            <CommentComposer tab={tab} />
          </div>

          <aside className="overview-side">
            <SideCard title="Reviewers">
              {reviewerSummary.length === 0 ? <span className="muted">none requested</span> : null}
              {reviewerSummary.map((reviewer) => (
                <div className="overview-side-row" key={reviewer.login}>
                  <Avatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} size="s" />
                  <span className="mono">{reviewer.login}</span>
                </div>
              ))}
            </SideCard>

            <SideCard title="Checks">
              {tab.bundle.checks.length === 0 ? <span className="muted">No check runs loaded</span> : null}
              {tab.bundle.checks.map((check) => (
                <a className="overview-check-row" href={check.url} target="_blank" rel="noreferrer" key={check.id}>
                  <CheckCircle2 size={13} aria-hidden="true" className={statusClass(check.conclusion ?? check.status)} />
                  <span className="mono">{check.name}</span>
                  <span className={`status-pill ${statusClass(check.conclusion ?? check.status)}`}>
                    {check.conclusion ?? check.status}
                  </span>
                </a>
              ))}
            </SideCard>

            <SideCard title="Labels">
              <div className="file-pills">
                {detail.labels.length === 0 ? <span>unlabeled</span> : null}
                {detail.labels.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </SideCard>

            <SideCard title="Stats">
              <Stat label="Mode" value={tab.mode === "managed" ? "Managed" : "API"} />
              <Stat label="Files" value={formatCount(totalFiles)} />
              <Stat label="Lines added" value={`+${formatCount(detail.additions)}`} kind="add" />
              <Stat label="Lines removed" value={`−${formatCount(detail.deletions)}`} kind="del" />
              <Stat label="Threads" value={formatCount(tab.bundle.reviewThreads.length)} />
              <Stat label="Updated" value={formatDate(detail.updatedAt)} />
            </SideCard>

            <button
              type="button"
              className="primary-button overview-start-review"
              onClick={() => setTabViewMode(tab.key, "review")}
            >
              <GitPullRequestArrow size={13} aria-hidden="true" />
              Start review
            </button>
          </aside>
        </div>
      </div>
    </main>
  );
}

function stateBadge(state: string, draft: boolean): React.JSX.Element {
  if (draft) {
    return <span className="chip">Draft</span>;
  }
  if (state === "open") {
    return (
      <span className="chip add">
        <span className="dot" />
        Open
      </span>
    );
  }
  if (state === "merged") {
    return <span className="chip accent">Merged</span>;
  }
  return <span className="chip">{state}</span>;
}

interface AvatarProps {
  login: string;
  avatarUrl?: string;
  size?: "s" | "m";
}

function Avatar({ login, avatarUrl, size = "m" }: AvatarProps): React.JSX.Element {
  const initials = login
    .replace(/[^a-zA-Z0-9]/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
  const url = avatarUrl ?? githubAvatarUrl(login);
  return (
    <span className={`avatar ${size === "s" ? "is-s" : ""}`} aria-label={login} title={login}>
      {url ? (
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
      <span className="avatar-fallback" aria-hidden="true">{initials}</span>
    </span>
  );
}

function githubAvatarUrl(login: string): string | null {
  if (!login) {
    return null;
  }
  if (login.includes("[bot]")) {
    return null;
  }
  return `https://github.com/${login}.png?size=64`;
}

interface SideCardProps {
  title: string;
  children: React.ReactNode;
}

function SideCard({ title, children }: SideCardProps): React.JSX.Element {
  return (
    <section className="overview-card">
      <header className="overview-card-header">{title}</header>
      <div className="overview-card-body">{children}</div>
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  kind?: "add" | "del";
}

function Stat({ label, value, kind }: StatProps): React.JSX.Element {
  const valueClass = kind === "add" ? "diff-counts-add" : kind === "del" ? "diff-counts-del" : "";
  return (
    <div className="overview-stat">
      <span>{label}</span>
      <span className={`mono ${valueClass}`}>{value}</span>
    </div>
  );
}

interface CommentComposerProps {
  tab: PrTab;
}

function CommentComposer({ tab }: CommentComposerProps): React.JSX.Element {
  const [composerTab, setComposerTab] = useState<"write" | "preview">("write");
  const [body, setBody] = useState("");
  const composerMutation = useMutation({
    mutationFn: () =>
      krtClient.comments.postIssueComment({
        repository: tab.bundle.detail.repository,
        number: tab.bundle.detail.number,
        body
      }),
    onSuccess: () => setBody("")
  });
  const empty = !body.trim();
  return (
    <section className="comment-composer">
      <header className="comment-composer-tabs">
        <button
          type="button"
          className={composerTab === "write" ? "comment-composer-tab is-active" : "comment-composer-tab"}
          onClick={() => setComposerTab("write")}
        >
          Write
        </button>
        <button
          type="button"
          className={composerTab === "preview" ? "comment-composer-tab is-active" : "comment-composer-tab"}
          onClick={() => setComposerTab("preview")}
        >
          Preview
        </button>
      </header>
      {composerTab === "write" ? (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Leave a comment… (Markdown supported)"
          rows={4}
        />
      ) : (
        <div
          className="comment-composer-preview markdown"
          dangerouslySetInnerHTML={{
            __html: empty ? "<em>Nothing to preview yet.</em>" : renderMarkdown(body)
          }}
        />
      )}
      <footer className="comment-composer-footer">
        <span className="muted">Markdown · ⌘↵ to send</span>
        <button
          type="button"
          className="secondary-button"
          disabled={empty || composerMutation.isPending}
          onClick={() => composerMutation.mutate()}
        >
          <MessageSquare size={11} aria-hidden="true" />
          Comment
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={composerMutation.isPending}
          onClick={() => composerMutation.mutate()}
        >
          <Check size={11} aria-hidden="true" />
          Approve
        </button>
      </footer>
    </section>
  );
}

function ReviewThreadsPanel({ tab }: { tab: PrTab }): React.JSX.Element | null {
  const [replyByThread, setReplyByThread] = useState<Record<string, string>>({});
  const updateReviewThread = useUiStore((state) => state.updateReviewThread);
  const appendReviewThreadComment = useUiStore((state) => state.appendReviewThreadComment);
  const resolveMutation = useMutation({
    mutationFn: (thread: ReviewThread) =>
      thread.resolved
        ? krtClient.reviews.reopenThread({
            repository: tab.bundle.detail.repository,
            number: tab.bundle.detail.number,
            threadId: thread.id
          })
        : krtClient.reviews.resolveThread({
            repository: tab.bundle.detail.repository,
            number: tab.bundle.detail.number,
            threadId: thread.id
          }),
    onSuccess: (thread) => updateReviewThread(tab.key, thread)
  });
  const replyMutation = useMutation({
    mutationFn: (thread: ReviewThread) =>
      krtClient.comments.replyToReviewThread({
        repository: tab.bundle.detail.repository,
        number: tab.bundle.detail.number,
        threadId: thread.id,
        body: replyByThread[thread.id] ?? ""
      }),
    onSuccess: (reply, thread) => {
      appendReviewThreadComment(tab.key, thread.id, reply);
      setReplyByThread((current) => ({ ...current, [thread.id]: "" }));
    }
  });

  if (tab.bundle.reviewThreads.length === 0) {
    return null;
  }

  return (
    <section className="threads-section">
      <h2 className="overview-section-heading">Review Threads</h2>
      <div className="thread-list">
        {tab.bundle.reviewThreads.map((thread) => (
          <article className="thread-card" key={thread.id}>
            <div className="thread-topline">
              <strong className="mono">{thread.path ?? "Pull request"}</strong>
              <span className={thread.resolved ? "status-pill status-success" : "status-pill status-pending"}>
                {thread.resolved ? "resolved" : "open"}
              </span>
            </div>
            {thread.comments.at(-1) ? <p>{thread.comments.at(-1)?.body}</p> : null}
            <textarea
              value={replyByThread[thread.id] ?? ""}
              rows={3}
              onChange={(event) =>
                setReplyByThread((current) => ({ ...current, [thread.id]: event.target.value }))
              }
            />
            <div className="thread-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={resolveMutation.isPending}
                onClick={() => resolveMutation.mutate(thread)}
              >
                {thread.resolved ? "Reopen" : "Resolve"}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={replyMutation.isPending || !(replyByThread[thread.id] ?? "").trim()}
                onClick={() => replyMutation.mutate(thread)}
              >
                Reply
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

type ActivityFilter = "all" | "comments" | "bots" | "checks" | "reviews" | "automation";

const activityFilters: Array<{ id: ActivityFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "comments", label: "Discussion" },
  { id: "bots", label: "Bots" },
  { id: "checks", label: "CI" },
  { id: "reviews", label: "Reviews" },
  { id: "automation", label: "Automation" }
];

function ActivitySection({ tab }: { tab: PrTab }): React.JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const counts = useMemo(() => countActivities(tab.bundle.timeline), [tab.bundle.timeline]);
  const filteredEvents = useMemo(
    () => tab.bundle.timeline.filter((event) => matchesActivityFilter(event, filter)),
    [filter, tab.bundle.timeline]
  );

  return (
    <section className="activity-section">
      <h2 className="overview-section-heading">Activity</h2>
      <div className="activity-tabs" role="tablist" aria-label="Activity filters">
        {activityFilters.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={filter === item.id ? "activity-tab is-active" : "activity-tab"}
            key={item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            <span>{counts[item.id]}</span>
          </button>
        ))}
      </div>
      <div className="activity-list">
        {tab.bundle.timeline.length === 0 ? <span className="muted">No activity loaded</span> : null}
        {tab.bundle.timeline.length > 0 && filteredEvents.length === 0 ? (
          <span className="muted">No activity in this category</span>
        ) : null}
        {filteredEvents.map((event) => (
          <article className="activity-row" key={event.id}>
            {event.kind === "check" ? <Play size={13} aria-hidden="true" /> : event.kind === "bot" ? <Bot size={13} aria-hidden="true" /> : <MessageSquare size={13} aria-hidden="true" />}
            <div>
              <div className="activity-title-row">
                <strong>{event.title}</strong>
                <span className={`status-pill status-${event.severity}`}>{event.kind}</span>
              </div>
              <span>{event.actor?.login ?? event.kind} - {formatDate(event.createdAt)}</span>
              {event.body ? (
                <div
                  className="markdown compact"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(event.body.slice(0, 800)) }}
                />
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function countActivities(events: ActivityEvent[]): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = {
    all: events.length,
    comments: 0,
    bots: 0,
    checks: 0,
    reviews: 0,
    automation: 0
  };
  for (const event of events) {
    if (matchesActivityFilter(event, "comments")) counts.comments += 1;
    if (matchesActivityFilter(event, "bots")) counts.bots += 1;
    if (matchesActivityFilter(event, "checks")) counts.checks += 1;
    if (matchesActivityFilter(event, "reviews")) counts.reviews += 1;
    if (matchesActivityFilter(event, "automation")) counts.automation += 1;
  }
  return counts;
}

function matchesActivityFilter(event: ActivityEvent, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "comments") return event.kind === "comment";
  if (filter === "bots") return event.kind === "bot";
  if (filter === "checks") return event.kind === "check";
  if (filter === "reviews") return event.kind === "review";
  return event.kind === "label" || event.kind === "commit" || event.kind === "automation";
}
