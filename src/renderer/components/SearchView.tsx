import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, GitBranch, Github, Loader2, Pin, PinOff, Search, Trash2, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { krtClient } from "../api/client.js";
import { formatBytes, formatCount, formatDate } from "../lib/format.js";
import { activeTokenAt, suggestFilters, type FilterSuggestion } from "../lib/githubFilters.js";
import { useUiStore } from "../store/uiStore.js";
import type { AppSettings, ManagedWorktree, PullRequestSummary, RepositoryRef } from "../../shared/schemas.js";
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

  const prUrlTarget = useMemo(() => parsePullRequestUrl(query), [query]);
  const composedQuery = useMemo(
    () => composeSearchQuery(query, ownerRepoNormalized, pinnedRepos),
    [query, ownerRepoNormalized, pinnedRepos]
  );
  const searchQuery = useQuery({
    queryKey: ["pull-request-search", composedQuery, githubAuthed],
    enabled: githubAuthed && !prUrlTarget,
    queryFn: () =>
      krtClient.pullRequests.search({
        provider: "github",
        query: composedQuery,
        limit: 25
      })
  });
  const checkedOutBranchesQuery = useQuery({
    queryKey: ["managed-worktrees"],
    queryFn: () => krtClient.repos.listManagedWorktrees()
  });
  const [deletingWorktreeKeys, setDeletingWorktreeKeys] = useState<ReadonlySet<string>>(() => new Set());
  const deleteWorktree = (worktree: ManagedWorktree): void => {
    const key = managedWorktreeKey(worktree);
    if (deletingWorktreeKeys.has(key)) {
      return;
    }
    setDeletingWorktreeKeys((current) => new Set(current).add(key));
    void krtClient.repos
      .deleteWorktree({
        repository: worktree.repository,
        number: worktree.number,
        headSha: worktree.headSha
      })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: ["managed-worktrees"] });
        void queryClient.invalidateQueries({ queryKey: ["workspace-tree"] });
        void queryClient.invalidateQueries({ queryKey: ["lsp-session"] });
        void queryClient.invalidateQueries({ queryKey: ["lsp-diagnostics"] });
      })
      .finally(() => {
        setDeletingWorktreeKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  };

  const openMutation = useMutation({
    mutationFn: (input: { repository: RepositoryRef; number: number }) =>
      krtClient.pullRequests.startOpen({
        repository: input.repository,
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
          <h1>Open a Pull Request</h1>
          <p>
            Type a number, branch fragment, author, or any word from the title. Use <span className="kbd">/</span> to add filters.
          </p>
        </section>

        <FilterSearchInput
          inputRef={inputRef}
          value={query}
          onChange={setQuery}
          onSubmit={() => {
            if (prUrlTarget) {
              setSelectedSearchResult(null);
              openMutation.mutate(prUrlTarget);
            }
          }}
        />


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

        {githubAuthed && prUrlTarget ? (
          <section className="result-panel" aria-label="Open pull request from link">
            <button
              type="button"
              className="result-row"
              onClick={() => {
                setSelectedSearchResult(null);
                openMutation.mutate(prUrlTarget);
              }}
            >
              <span className="avatar" aria-hidden="true">
                <span className="avatar-fallback">
                  <GitBranch size={16} />
                </span>
              </span>
              <div className="result-main">
                <div className="result-title-row">
                  <span className="num">#{prUrlTarget.number}</span>
                  <strong>Open from link</strong>
                </div>
                <div className="result-meta">
                  <span className="mono">{prUrlTarget.repository.fullName}</span>
                  <span aria-hidden="true">·</span>
                  <span>Press Enter to open</span>
                </div>
              </div>
            </button>
          </section>
        ) : null}

        {githubAuthed && !prUrlTarget && searchQuery.isLoading ? <SearchResultsSkeleton /> : null}
        {githubAuthed && !prUrlTarget && searchQuery.isError ? (
          <div className="error-panel">{errorMessage(searchQuery.error)}</div>
        ) : null}

        {!prUrlTarget ? (
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
                openMutation.mutate({ repository: pullRequest.repository, number: pullRequest.number });
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
                  <span className="mono result-branch">
                    <GitBranch size={11} aria-hidden="true" /> {pullRequest.headRef || shortSha(pullRequest.headSha)}
                  </span>
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
        ) : null}

        <CheckedOutBranchesPanel
          error={checkedOutBranchesQuery.error}
          isLoading={checkedOutBranchesQuery.isLoading}
          onOpen={(worktree) => {
            openMutation.mutate({ repository: worktree.repository, number: worktree.number });
          }}
          onDelete={deleteWorktree}
          deletingKeys={deletingWorktreeKeys}
          worktrees={checkedOutBranchesQuery.data ?? []}
        />

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

interface FilterSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSubmit?: () => void;
}

function FilterSearchInput({ value, onChange, inputRef, onSubmit }: FilterSearchInputProps): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const token = useMemo(() => activeTokenAt(value, caret), [value, caret]);
  const suggestions = useMemo(() => suggestFilters(token.text), [token.text]);
  const menuOpen = open && suggestions.length > 0;

  useEffect(() => {
    if (highlight >= suggestions.length) {
      setHighlight(0);
    }
  }, [highlight, suggestions.length]);

  // Restore the caret after a suggestion rewrites the query value.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) {
      return;
    }
    const next = pendingCaret.current;
    pendingCaret.current = null;
    const input = inputRef.current;
    if (input) {
      input.setSelectionRange(next, next);
    }
    setCaret(next);
  }, [value, inputRef]);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const onPointer = (event: PointerEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [menuOpen]);

  const syncCaret = (input: HTMLInputElement): void => {
    setCaret(input.selectionStart ?? input.value.length);
  };

  const apply = (suggestion: FilterSuggestion): void => {
    const before = value.slice(0, token.start);
    const after = value.slice(caret);
    const nextValue = before + suggestion.insert + after;
    const nextCaret = before.length + suggestion.insert.length;
    pendingCaret.current = nextCaret;
    onChange(nextValue);
    setHighlight(0);
    setOpen(Boolean(suggestion.keepOpen));
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (menuOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => (current + delta + suggestions.length) % suggestions.length);
      return;
    }
    if (menuOpen && (event.key === "Enter" || event.key === "Tab")) {
      const picked = suggestions[highlight];
      if (picked) {
        event.preventDefault();
        apply(picked);
      }
      return;
    }
    if (event.key === "Escape" && menuOpen) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Enter" && !menuOpen && onSubmit) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <section className="search-box filter-search" aria-label="Pull request search" ref={wrapperRef}>
      <Search size={17} aria-hidden="true" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => syncCaret(event.currentTarget)}
        onClick={(event) => syncCaret(event.currentTarget)}
        onSelect={(event) => syncCaret(event.currentTarget)}
        onFocus={() => setOpen(true)}
        placeholder="Search PRs by #number, branch, author, or title — type / for filters"
        aria-autocomplete="list"
        aria-controls={menuOpen ? listId : undefined}
        aria-expanded={menuOpen}
        role="combobox"
      />
      <span className="kbd">Cmd K</span>
      {menuOpen ? (
        <ul className="filter-menu" role="listbox" id={listId}>
          {suggestions.map((suggestion, index) => {
            const isHighlighted = highlight === index;
            return (
              <li
                key={suggestion.id}
                role="option"
                aria-selected={isHighlighted}
                className={isHighlighted ? "filter-option is-highlighted" : "filter-option"}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => apply(suggestion)}
              >
                <span className="mono filter-option-label">{suggestion.label}</span>
                {suggestion.description ? (
                  <span className="filter-option-desc">{suggestion.description}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

interface CheckedOutBranchesPanelProps {
  worktrees: ManagedWorktree[];
  isLoading: boolean;
  error: unknown;
  deletingKeys: ReadonlySet<string>;
  onOpen: (worktree: ManagedWorktree) => void;
  onDelete: (worktree: ManagedWorktree) => void;
}

function CheckedOutBranchesPanel({
  worktrees,
  isLoading,
  error,
  deletingKeys,
  onOpen,
  onDelete
}: CheckedOutBranchesPanelProps): React.JSX.Element {
  return (
    <section className="checked-out-branches" aria-label="Checked out branches">
      <div className="checked-out-branches-header">
        <div>
          <h2>Checked out branches</h2>
        </div>
        <span className="checked-out-count">{worktrees.length}</span>
      </div>
      {isLoading ? <div className="checked-out-empty">Loading checked out branches...</div> : null}
      {!isLoading && error ? <div className="checked-out-empty">{errorMessage(error)}</div> : null}
      {!isLoading && !error && worktrees.length === 0 ? (
        <div className="checked-out-empty">No checked out branches.</div>
      ) : null}
      {!isLoading && !error && worktrees.length > 0 ? (
        <div className="checked-out-list">
          {worktrees.map((worktree) => {
            const key = managedWorktreeKey(worktree);
            const deleting = deletingKeys.has(key);
            return (
              <div className="checked-out-row" key={key}>
                <button
                  type="button"
                  className="checked-out-open"
                  onClick={() => onOpen(worktree)}
                  title={`Open ${worktree.repository.fullName}#${worktree.number}`}
                >
                  <GitBranch size={15} aria-hidden="true" />
                  <div className="checked-out-main">
                    <div className="checked-out-title-row">
                      <strong className="mono">{worktree.headRef ?? shortSha(worktree.headSha)}</strong>
                      {worktree.active ? <span className="chip add">Active</span> : null}
                    </div>
                    <div className="checked-out-meta">
                      <span className="mono">{worktree.repository.fullName}</span>
                      <span aria-hidden="true">·</span>
                      <span>PR #{worktree.number}</span>
                      {worktree.baseRef ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="mono">{worktree.baseRef}</span>
                        </>
                      ) : null}
                      <span aria-hidden="true">·</span>
                      <span>{shortSha(worktree.headSha)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(worktree.sizeBytes)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDate(worktree.lastUsedAt)}</span>
                    </div>
                    {worktree.title ? <div className="checked-out-title">{worktree.title}</div> : null}
                  </div>
                </button>
                <button
                  type="button"
                  className="checked-out-delete"
                  disabled={deleting}
                  onClick={() => onDelete(worktree)}
                  title={`Delete ${worktree.repository.fullName}#${worktree.number}`}
                >
                  {deleting ? <Loader2 className="spin" size={13} aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
                  {deleting ? "Deleting" : "Delete"}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
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

// Recognizes a GitHub pull request URL so it can be opened directly instead of
// being run as a search query. Accepts URLs with or without a scheme, and
// ignores trailing path segments (e.g. /files) and fragments.
function parsePullRequestUrl(input: string): { repository: RepositoryRef; number: number } | null {
  const trimmed = input.trim();
  if (!trimmed || !/github\.com/i.test(trimmed)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    return null;
  }
  const [owner, name] = parts;
  const number = Number.parseInt(parts[3], 10);
  if (!owner || !name || !Number.isInteger(number) || number <= 0) {
    return null;
  }
  return {
    repository: { provider: "github", owner, name, fullName: `${owner}/${name}` },
    number
  };
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

function managedWorktreeKey(worktree: ManagedWorktree): string {
  return `${worktree.repository.provider}:${worktree.repository.fullName}:${worktree.number}:${worktree.headSha}`;
}

function shortSha(value: string): string {
  return value.slice(0, 12);
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
