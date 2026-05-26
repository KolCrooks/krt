import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, GitBranch, Github, Loader2, Pin, PinOff, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { krtClient } from "../api/client.js";
import { formatCount, formatDate } from "../lib/format.js";
import { useUiStore } from "../store/uiStore.js";
import type { AppSettings, PullRequestSummary } from "../../shared/schemas.js";
import type { OperationProgress } from "../../shared/schemas.js";

export function SearchView(): React.JSX.Element {
  const [query, setQuery] = useState("is:open sort:updated-desc");
  const [ownerRepo, setOwnerRepo] = useState("");
  const [openOperationId, setOpenOperationId] = useState<string | null>(null);
  const [openProgress, setOpenProgress] = useState<OperationProgress | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openPrTab = useUiStore((state) => state.openPrTab);
  const setSelectedSearchResult = useUiStore((state) => state.setSelectedSearchResult);
  const openModal = useUiStore((state) => state.openModal);
  const queryClient = useQueryClient();
  const authQuery = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => krtClient.auth.getStatus()
  });
  const githubAuthed = Boolean(authQuery.data?.github);
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => krtClient.settings.get()
  });
  const pinnedRepos = settingsQuery.data?.pinnedRepos ?? [];
  const updatePinnedRepos = useMutation({
    mutationFn: (next: string[]) => krtClient.settings.update({ pinnedRepos: next }),
    onMutate: async (next) => {
      queryClient.setQueryData<AppSettings>(["settings"], (current) =>
        current ? { ...current, pinnedRepos: next } : current
      );
    },
    onSuccess: (settings) => queryClient.setQueryData(["settings"], settings)
  });
  const ownerRepoNormalized = ownerRepo.trim();
  const isCurrentPinned = ownerRepoNormalized.length > 0 && pinnedRepos.includes(ownerRepoNormalized);
  const togglePin = (repo: string): void => {
    const next = pinnedRepos.includes(repo)
      ? pinnedRepos.filter((entry) => entry !== repo)
      : [...pinnedRepos, repo];
    updatePinnedRepos.mutate(next);
  };

  const composedQuery = useMemo(
    () => composeSearchQuery(query, ownerRepoNormalized, pinnedRepos),
    [query, ownerRepoNormalized, pinnedRepos]
  );
  const searchQuery = useQuery({
    queryKey: ["pull-request-search", composedQuery, githubAuthed],
    enabled: githubAuthed,
    queryFn: () =>
      krtClient.pullRequests.search({
        provider: "github",
        query: composedQuery,
        limit: 25
      })
  });

  const openMutation = useMutation({
    mutationFn: (input: { ownerRepo: string; number: number }) =>
      krtClient.pullRequests.startOpen({
        repository: {
          provider: "github",
          owner: input.ownerRepo.split("/")[0],
          name: input.ownerRepo.split("/")[1],
          fullName: input.ownerRepo,
          url: `https://github.com/${input.ownerRepo}`
        },
        number: input.number,
        preferredMode: "auto"
      }),
    onSuccess: (result) => {
      setOpenOperationId(result.operationId);
      setOpenProgress({
        operationId: result.operationId,
        phase: "pullRequests.open",
        message: "Opening pull request",
        percent: 0,
        done: false,
        cancelled: false
      });
      void krtClient.operations.progressSnapshot({ operationId: result.operationId }).then((snapshot) => {
        if (snapshot) {
          setOpenProgress(snapshot);
        }
      });
    }
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!openOperationId) {
      return undefined;
    }

    return krtClient.operations.onProgress((progress) => {
      if (progress.operationId === openOperationId) {
        setOpenProgress(progress);
      }
    });
  }, [openOperationId]);

  useEffect(() => {
    if (!openOperationId || !openProgress?.done || openProgress.cancelled || openProgress.phase !== "complete") {
      return undefined;
    }

    let active = true;
    void krtClient.pullRequests.openResult({ operationId: openOperationId }).then((bundle) => {
      if (!active || !bundle) {
        return;
      }
      openPrTab(bundle);
      setOpenOperationId(null);
      setOpenProgress(null);
    });

    return () => {
      active = false;
    };
  }, [openOperationId, openPrTab, openProgress?.cancelled, openProgress?.done, openProgress?.phase]);

  const openActive = openMutation.isPending || Boolean(openOperationId && (!openProgress || !openProgress.done));
  const openTerminalError = Boolean(openProgress?.done && (openProgress.cancelled || openProgress.phase === "failed"));
  const showOpenBanner = openActive || openTerminalError;
  const pullRequests = searchQuery.data ?? [];
  const filteredPullRequests = pullRequests;
  const repoCandidates = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const pr of pullRequests) {
      const name = pr.repository.fullName;
      if (!seen.has(name)) {
        seen.add(name);
        list.push(name);
      }
    }
    return list;
  }, [pullRequests]);

  return (
    <main className="view search-view">
      <div className="search-inner">
        <section className="search-heading">
          <span className="eyebrow">Open a Pull Request</span>
          <h1>Find anything in seconds.</h1>
          <p>
            Type a number, branch fragment, author, or any word from the title. Use <span className="kbd">/</span> to focus,
            <span className="kbd"> Enter</span> to open.
          </p>
        </section>

        <section className="search-box" aria-label="Pull request search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search PRs by #number, branch, author, or title..."
          />
          <span className="kbd">Cmd K</span>
        </section>

        <div className="pinned-row" aria-label="Pinned repositories">
          <button
            type="button"
            className={ownerRepoNormalized === "" ? "pinned-chip is-active" : "pinned-chip"}
            onClick={() => setOwnerRepo("")}
          >
            All repos
            {pinnedRepos.length > 0 ? <span>{pinnedRepos.length}</span> : null}
          </button>
          {pinnedRepos.map((repo) => {
            const active = ownerRepoNormalized === repo;
            return (
              <button
                type="button"
                className={active ? "pinned-chip is-active" : "pinned-chip"}
                key={repo}
                onClick={() => setOwnerRepo(active ? "" : repo)}
              >
                <span className="mono">{repo}</span>
                <span
                  className="pinned-chip-remove"
                  role="button"
                  aria-label={`Unpin ${repo}`}
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePin(repo);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      togglePin(repo);
                    }
                  }}
                >
                  <X size={10} aria-hidden="true" />
                </span>
              </button>
            );
          })}
          <span className="pinned-spacer" />
          <RepoCombobox
            value={ownerRepo}
            onChange={setOwnerRepo}
            pinnedRepos={pinnedRepos}
            onTogglePin={togglePin}
            candidates={repoCandidates}
            isCurrentPinned={isCurrentPinned}
          />
        </div>

        {!authQuery.isLoading && !githubAuthed ? (
          <section className="auth-banner" role="status">
            <Github size={16} aria-hidden="true" />
            <div className="auth-banner-body">
              <strong>Connect GitHub to search pull requests.</strong>
              <span>Pull request search uses your token directly — without it, no repos are reachable.</span>
            </div>
            <button type="button" className="primary-button" onClick={() => openModal("settings")}>
              Connect
            </button>
          </section>
        ) : null}

        {githubAuthed && searchQuery.isLoading ? <SearchResultsSkeleton /> : null}
        {githubAuthed && searchQuery.isError ? <div className="error-panel">{errorMessage(searchQuery.error)}</div> : null}

        <section className="result-panel" aria-label="Pull request results">
          {githubAuthed && filteredPullRequests.length === 0 && !searchQuery.isLoading && !searchQuery.isError ? (
            <div className="empty-result">No PRs match.</div>
          ) : null}
          {filteredPullRequests.map((pullRequest) => (
            <button
              type="button"
              className="result-row"
              key={`${pullRequest.repository.fullName}-${pullRequest.number}`}
              onClick={() => {
                setSelectedSearchResult(pullRequest);
                openMutation.mutate({ ownerRepo: pullRequest.repository.fullName, number: pullRequest.number });
              }}
            >
              <SearchAvatar login={pullRequest.author.login} avatarUrl={pullRequest.author.avatarUrl} />
              <div className="result-main">
                <div className="result-title-row">
                  <span className="num">#{pullRequest.number}</span>
                  <strong>{pullRequest.title}</strong>
                </div>
                <div className="result-meta">
                  <span className="mono">{pullRequest.repository.fullName}</span>
                  <span aria-hidden="true">·</span>
                  <span className="mono result-branch"><GitBranch size={11} aria-hidden="true" /> {pullRequest.headRef}</span>
                  <span aria-hidden="true">·</span>
                  <span>by {pullRequest.author.login}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatDate(pullRequest.updatedAt)}</span>
                </div>
              </div>
              <div className="result-stats">
                {pullRequest.additions > 0 || pullRequest.deletions > 0 ? (
                  <span className="mono">
                    {pullRequest.additions > 0 ? <span className="diff-counts-add">+{formatCount(pullRequest.additions)}</span> : null}
                    {pullRequest.additions > 0 && pullRequest.deletions > 0 ? " " : ""}
                    {pullRequest.deletions > 0 ? <span className="diff-counts-del">−{formatCount(pullRequest.deletions)}</span> : null}
                  </span>
                ) : null}
                {pullRequest.changedFileCount > 0 ? <span className="chip">{formatCount(pullRequest.changedFileCount)} files</span> : null}
                <span className={stateChipClass(pullRequest)}>{stateLabel(pullRequest)}</span>
              </div>
            </button>
          ))}
        </section>

      </div>
      {showOpenBanner ? (
        <aside className={openTerminalError ? "operation-banner is-fixed is-terminal" : "operation-banner is-fixed"}>
          {openActive ? <Loader2 className="spin" size={15} aria-hidden="true" /> : <Ban size={15} aria-hidden="true" />}
          <span>{openProgress?.message ?? "Opening pull request"}</span>
          {typeof openProgress?.percent === "number" ? <strong>{Math.round(openProgress.percent)}%</strong> : null}
          {openActive && openOperationId ? (
            <button type="button" className="secondary-button" onClick={() => krtClient.operations.cancel({ operationId: openOperationId })}>
              Cancel
            </button>
          ) : null}
        </aside>
      ) : null}
    </main>
  );
}

interface RepoComboboxProps {
  value: string;
  onChange: (value: string) => void;
  pinnedRepos: string[];
  onTogglePin: (repo: string) => void;
  candidates: string[];
  isCurrentPinned: boolean;
}

function RepoCombobox({
  value,
  onChange,
  pinnedRepos,
  onTogglePin,
  candidates,
  isCurrentPinned
}: RepoComboboxProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  const options = useMemo(() => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const repo of pinnedRepos) {
      if (!seen.has(repo)) {
        seen.add(repo);
        merged.push(repo);
      }
    }
    for (const repo of candidates) {
      if (!seen.has(repo)) {
        seen.add(repo);
        merged.push(repo);
      }
    }
    return merged
      .filter((repo) => (lower ? repo.toLowerCase().includes(lower) : true))
      .slice(0, 8);
  }, [candidates, lower, pinnedRepos]);

  useEffect(() => {
    if (highlight >= options.length) {
      setHighlight(0);
    }
  }, [highlight, options.length]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointer = (event: PointerEvent): void => {
      if (!wrapperRef.current) {
        return;
      }
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => (options.length ? (current + 1) % options.length : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => (options.length ? (current - 1 + options.length) % options.length : 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = options[highlight];
      if (picked) {
        onChange(picked);
        setOpen(false);
        return;
      }
      if (trimmed && /\//.test(trimmed)) {
        onTogglePin(trimmed);
        setOpen(false);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showPinButton = trimmed.length > 0 && /\//.test(trimmed) && !pinnedRepos.includes(trimmed);

  return (
    <div className="repo-combobox" ref={wrapperRef}>
      <input
        ref={inputRef}
        className="pinned-input"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder="owner/repo"
        aria-label="Filter by repository"
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        role="combobox"
      />
      {showPinButton ? (
        <button
          type="button"
          className="pinned-pin-btn"
          onClick={() => onTogglePin(trimmed)}
          aria-label={isCurrentPinned ? "Unpin repository" : "Pin repository"}
          title={isCurrentPinned ? "Unpin repository" : "Pin repository"}
        >
          {isCurrentPinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
          {isCurrentPinned ? "Unpin" : "Pin"}
        </button>
      ) : null}
      {open && options.length > 0 ? (
        <ul className="repo-combobox-menu" role="listbox" id={listId}>
          {options.map((repo, index) => {
            const isPinned = pinnedRepos.includes(repo);
            const isHighlighted = highlight === index;
            return (
              <li
                key={repo}
                role="option"
                aria-selected={isHighlighted}
                className={isHighlighted ? "repo-combobox-option is-highlighted" : "repo-combobox-option"}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(repo);
                  setOpen(false);
                }}
              >
                <span className="mono repo-combobox-name">{repo}</span>
                {isPinned ? <span className="repo-combobox-pinned">pinned</span> : null}
                <button
                  type="button"
                  className="repo-combobox-pin"
                  aria-label={isPinned ? `Unpin ${repo}` : `Pin ${repo}`}
                  title={isPinned ? "Unpin" : "Pin"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePin(repo);
                  }}
                >
                  {isPinned ? <PinOff size={11} aria-hidden="true" /> : <Pin size={11} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function SearchResultsSkeleton(): React.JSX.Element {
  return (
    <section className="result-panel result-panel-skeleton" aria-label="Loading pull requests">
      {Array.from({ length: 4 }).map((_, index) => (
        <div className="result-row-skeleton" key={index}>
          <div className="skeleton skeleton-avatar" />
          <div className="result-row-skeleton-body">
            <div className="skeleton skeleton-line skeleton-line-wide" />
            <div className="skeleton skeleton-line skeleton-line-narrow" />
          </div>
          <div className="skeleton skeleton-chip" />
        </div>
      ))}
    </section>
  );
}

function composeSearchQuery(baseQuery: string, ownerRepo: string, pinnedRepos: string[]): string {
  if (ownerRepo) {
    return `repo:${ownerRepo} ${baseQuery}`.trim();
  }
  if (pinnedRepos.length > 0) {
    const qualifiers = pinnedRepos.map((repo) => `repo:${repo}`).join(" ");
    return `${qualifiers} ${baseQuery}`.trim();
  }
  return baseQuery.trim();
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error) {
    if ("code" in error && error.code === "missing_provider_token") {
      return "Connect a GitHub token in Settings to search.";
    }
    if ("message" in error) {
      return String(error.message);
    }
  }
  return "Request failed";
}

function initials(login: string): string {
  const clean = login.replace(/[^a-zA-Z0-9]/g, "");
  return (clean.slice(0, 2) || "PR").toUpperCase();
}

interface SearchAvatarProps {
  login: string;
  avatarUrl?: string;
}

function SearchAvatar({ login, avatarUrl }: SearchAvatarProps): React.JSX.Element {
  const url = avatarUrl ?? (login && !login.includes("[bot]") ? `https://github.com/${login}.png?size=64` : null);
  return (
    <span className="avatar" aria-label={login} title={login}>
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
      <span className="avatar-fallback" aria-hidden="true">{initials(login)}</span>
    </span>
  );
}

function stateChipClass(pullRequest: PullRequestSummary): string {
  if (pullRequest.draft) {
    return "chip";
  }
  if (pullRequest.state === "merged") {
    return "chip accent";
  }
  if (pullRequest.state === "open" && pullRequest.reviewers.length > 0) {
    return "chip warn";
  }
  return "chip add";
}

function stateLabel(pullRequest: PullRequestSummary): string {
  if (pullRequest.draft) {
    return "Draft";
  }
  if (pullRequest.state === "merged") {
    return "Merged";
  }
  if (pullRequest.state === "open" && pullRequest.reviewers.length > 0) {
    return "Awaiting review";
  }
  return pullRequest.state;
}
