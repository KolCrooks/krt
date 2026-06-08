import { create } from "zustand";
import type {
  AgentActivity,
  DataMode,
  OperationProgress,
  PullRequestBundle,
  PullRequestSummary,
  ReactionGroup,
  ReviewComment,
  ReviewDraftComment,
  ReviewThread,
  ReviewTour
} from "../../shared/schemas.js";
import { orderChangedFilesDepthFirst } from "../../shared/treeModel.js";

export type AppView = "search" | "overview" | "review" | "editor";
export type TabViewMode = "overview" | "review" | "editor";
export type AppModal = "extensions" | "settings";
export type ReviewSubMode = "diff" | "tour" | "storyboard";
export type CheckoutState = "idle" | "checking" | "checked";

export interface TabCheckout {
  state: CheckoutState;
  dismissed: boolean;
  message: string | null;
  percent: number | null;
  operationId: string | null;
}

export interface TabFinishReview {
  open: boolean;
  body: string;
  comments: DraftReviewComment[];
}

export interface DraftReviewComment extends ReviewDraftComment {
  id: string;
}

export interface EditorNavigationTarget {
  path: string;
  line: number;
  requestId: number;
}

export interface PrTab {
  key: string;
  title: string;
  repository: string;
  number: number;
  mode: DataMode;
  bundle: PullRequestBundle;
  selectedFilePath: string | null;
  openFilePaths: string[];
  tour: ReviewTour | null;
  // In-flight AI tour generation, persisted on the tab so streaming survives
  // switching tabs or views (the view components mount/unmount freely).
  tourOperationId: string | null;
  tourProgress: OperationProgress | null;
  // Epoch ms when the current generation began, used to show elapsed "thinking"
  // time (there is no turn cap, so progress can't be expressed as a percentage).
  // Stamped when the operation starts, cleared when it finishes or resets.
  tourStartedAt?: number | null;
  // A running transcript of what the agent is doing (thinking, exploration, tool
  // calls), shown as a live chat feed while the tour generates. Reset on a new run.
  tourActivity?: AgentActivity[];
  reviewedTourChapterIds?: string[];
  viewMode: TabViewMode;
  reviewSubMode: ReviewSubMode;
  checkout: TabCheckout;
  finish: TabFinishReview;
  editorNavigationTarget?: EditorNavigationTarget | null;
}

const defaultCheckout: TabCheckout = {
  state: "idle",
  dismissed: false,
  message: null,
  percent: null,
  operationId: null
};

const defaultFinish: TabFinishReview = { open: false, body: "", comments: [] };
let editorNavigationRequestId = 0;
let draftReviewCommentId = 0;

interface UiState {
  activeView: AppView;
  modal: AppModal | null;
  tabs: PrTab[];
  activeTabKey: string | null;
  selectedSearchResult: PullRequestSummary | null;
  setActiveView: (view: AppView) => void;
  openModal: (modal: AppModal) => void;
  closeModal: () => void;
  setSelectedSearchResult: (result: PullRequestSummary | null) => void;
  openPrTab: (bundle: PullRequestBundle) => void;
  closeTab: (tabKey: string) => void;
  selectTab: (tabKey: string) => void;
  setTabMode: (tabKey: string, mode: DataMode) => void;
  setTabViewMode: (tabKey: string, viewMode: TabViewMode) => void;
  setReviewSubMode: (tabKey: string, subMode: ReviewSubMode) => void;
  updatePrTab: (bundle: PullRequestBundle) => void;
  selectFile: (tabKey: string, path: string) => void;
  closeFile: (tabKey: string, path: string) => void;
  openFileInTab: (tabKey: string, path: string, line?: number) => void;
  setTour: (tabKey: string, tour: ReviewTour | null) => void;
  toggleTourChapterReviewed: (tabKey: string, chapterId: string) => void;
  setTourOperation: (tabKey: string, operationId: string | null) => void;
  setTourProgress: (tabKey: string, progress: OperationProgress | null) => void;
  appendTourActivity: (tabKey: string, entry: AgentActivity) => void;
  updateReviewThread: (tabKey: string, thread: ReviewThread) => void;
  appendReviewThreadComment: (tabKey: string, threadId: string, comment: ReviewComment) => void;
  updateReviewThreadComment: (tabKey: string, threadId: string, comment: ReviewComment) => void;
  deleteReviewThreadComment: (tabKey: string, threadId: string, commentId: string) => void;
  setReviewCommentReactions: (tabKey: string, commentId: string, reactions: ReactionGroup[]) => void;
  setActivityEventReactions: (tabKey: string, eventId: string, reactions: ReactionGroup[]) => void;
  setCheckout: (tabKey: string, patch: Partial<TabCheckout>) => void;
  dismissCheckoutBanner: (tabKey: string) => void;
  setFinishOpen: (tabKey: string, open: boolean) => void;
  setFinishBody: (tabKey: string, body: string) => void;
  addDraftReviewComment: (tabKey: string, comment: ReviewDraftComment) => void;
  updateDraftReviewComment: (tabKey: string, commentId: string, patch: Partial<ReviewDraftComment>) => void;
  removeDraftReviewComment: (tabKey: string, commentId: string) => void;
  clearFinishReview: (tabKey: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeView: "search",
  modal: null,
  tabs: [],
  activeTabKey: null,
  selectedSearchResult: null,
  setActiveView: (activeView) => set({ activeView }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setSelectedSearchResult: (selectedSearchResult) => set({ selectedSearchResult }),
  openPrTab: (bundle) =>
    set((state) => {
      const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);
      const existing = state.tabs.find((tab) => tab.key === key);
      const initialSelectedFilePath = firstReviewFilePath(bundle);
      const tab: PrTab = {
        key,
        title: bundle.detail.title,
        repository: bundle.detail.repository.fullName,
        number: bundle.detail.number,
        mode: bundle.mode,
        bundle,
        selectedFilePath: initialSelectedFilePath,
        openFilePaths: [],
        tour: null,
        tourOperationId: null,
        tourProgress: null,
        tourStartedAt: null,
        tourActivity: [],
        reviewedTourChapterIds: [],
        viewMode: "overview",
        reviewSubMode: "diff",
        checkout: { ...defaultCheckout },
        finish: { ...defaultFinish },
        editorNavigationTarget: null
      };

      return {
        tabs: existing
          ? state.tabs.map((candidate) =>
              candidate.key === key
                ? { ...candidate, ...tab, tour: candidate.tour, tourOperationId: candidate.tourOperationId, tourProgress: candidate.tourProgress, tourStartedAt: candidate.tourStartedAt, tourActivity: candidate.tourActivity, reviewedTourChapterIds: candidate.reviewedTourChapterIds ?? [], viewMode: candidate.viewMode, reviewSubMode: candidate.reviewSubMode, checkout: candidate.checkout, finish: candidate.finish, editorNavigationTarget: candidate.editorNavigationTarget ?? null }
                : candidate
            )
          : [...state.tabs, tab],
        activeTabKey: key,
        activeView: "overview"
      };
    }),
  closeTab: (tabKeyToClose) =>
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.key !== tabKeyToClose);
      const nextTab = state.activeTabKey === tabKeyToClose ? tabs.at(-1) ?? null : state.tabs.find((tab) => tab.key === state.activeTabKey) ?? null;
      const activeTabKey = nextTab?.key ?? null;
      return {
        tabs,
        activeTabKey,
        activeView: activeTabKey && nextTab ? nextTab.viewMode : "search"
      };
    }),
  selectTab: (activeTabKey) =>
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.key === activeTabKey);
      if (!tab) {
        return { activeTabKey };
      }
      return { activeTabKey, activeView: tab.viewMode };
    }),
  setTabMode: (tabKeyToUpdate, mode) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.key === tabKeyToUpdate ? { ...tab, mode } : tab))
    })),
  setTabViewMode: (tabKeyToUpdate, viewMode) =>
    set((state) => ({
      activeView: state.activeTabKey === tabKeyToUpdate ? viewMode : state.activeView,
      tabs: state.tabs.map((tab) => {
        if (tab.key !== tabKeyToUpdate) {
          return tab;
        }
        if (
          viewMode === "editor" &&
          tab.selectedFilePath &&
          !tab.openFilePaths.includes(tab.selectedFilePath)
        ) {
          return {
            ...tab,
            viewMode,
            openFilePaths: [...tab.openFilePaths, tab.selectedFilePath]
          };
        }
        return { ...tab, viewMode };
      })
    })),
  setReviewSubMode: (tabKeyToUpdate, subMode) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.key === tabKeyToUpdate ? { ...tab, reviewSubMode: subMode } : tab))
    })),
  updatePrTab: (bundle) =>
    set((state) => {
      const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);
      return {
        tabs: state.tabs.map((tab) => {
          if (tab.key !== key) {
            return tab;
          }

          const selectedFilePath = bundle.changedFiles.some((file) => file.path === tab.selectedFilePath)
            ? tab.selectedFilePath
            : firstReviewFilePath(bundle);
          const openFilePaths = tab.openFilePaths.filter((path) => bundle.changedFiles.some((file) => file.path === path));
          const headShaChanged = tab.bundle.detail.headSha !== bundle.detail.headSha;
          return {
            ...tab,
            title: bundle.detail.title,
            mode: bundle.mode,
            bundle,
            selectedFilePath,
            openFilePaths: openFilePaths.length > 0 ? openFilePaths : selectedFilePath ? [selectedFilePath] : [],
            tour: headShaChanged ? null : tab.tour,
            tourOperationId: headShaChanged ? null : tab.tourOperationId,
            tourProgress: headShaChanged ? null : tab.tourProgress,
            tourStartedAt: headShaChanged ? null : tab.tourStartedAt,
            tourActivity: headShaChanged ? [] : tab.tourActivity,
            reviewedTourChapterIds: headShaChanged ? [] : tab.reviewedTourChapterIds,
            editorNavigationTarget: headShaChanged ? null : tab.editorNavigationTarget
          };
        })
      };
    }),
  selectFile: (tabKeyToUpdate, path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate ? { ...tab, selectedFilePath: path, editorNavigationTarget: null } : tab
      )
    })),
  openFileInTab: (tabKeyToUpdate, path, line) => {
    const editorNavigationTarget =
      line != null
        ? {
            path,
            line,
            requestId: ++editorNavigationRequestId
          }
        : null;
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              selectedFilePath: path,
              openFilePaths: tab.openFilePaths.includes(path) ? tab.openFilePaths : [...tab.openFilePaths, path],
              editorNavigationTarget
            }
          : tab
      )
    }));
  },
  closeFile: (tabKeyToUpdate, pathToClose) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.key !== tabKeyToUpdate) {
          return tab;
        }
        const index = tab.openFilePaths.indexOf(pathToClose);
        const openFilePaths = tab.openFilePaths.filter((path) => path !== pathToClose);
        const selectedFilePath =
          tab.selectedFilePath === pathToClose
            ? openFilePaths[Math.max(0, index - 1)] ?? openFilePaths[0] ?? null
            : tab.selectedFilePath;

        return {
          ...tab,
          selectedFilePath,
          openFilePaths,
          editorNavigationTarget: tab.editorNavigationTarget?.path === pathToClose ? null : tab.editorNavigationTarget
        };
      })
    })),
  setTour: (tabKeyToUpdate, tour) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              tour,
              reviewedTourChapterIds: pruneReviewedTourChapterIds(tab.reviewedTourChapterIds, tour)
            }
          : tab
      )
    })),
  toggleTourChapterReviewed: (tabKeyToUpdate, chapterId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.key !== tabKeyToUpdate) {
          return tab;
        }
        const reviewedIds = tab.reviewedTourChapterIds ?? [];
        const isReviewed = reviewedIds.includes(chapterId);
        return {
          ...tab,
          reviewedTourChapterIds: isReviewed
            ? reviewedIds.filter((id) => id !== chapterId)
            : [...reviewedIds, chapterId]
        };
      })
    })),
  setTourOperation: (tabKeyToUpdate, operationId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              tourOperationId: operationId,
              // Stamp the start when an operation begins (kept if already set);
              // clearing is handled when progress completes or resets.
              tourStartedAt: operationId ? tab.tourStartedAt ?? Date.now() : tab.tourStartedAt
            }
          : tab
      )
    })),
  setTourProgress: (tabKeyToUpdate, progress) =>
    set((state) => ({
      // A null or done progress marks a fresh start/reset or completion — clear the
      // activity feed and the elapsed-time anchor.
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              tourProgress: progress,
              tourActivity: progress ? tab.tourActivity : [],
              tourStartedAt: progress && !progress.done ? tab.tourStartedAt : null
            }
          : tab
      )
    })),
  appendTourActivity: (tabKeyToUpdate, entry) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.key !== tabKeyToUpdate) {
          return tab;
        }
        const feed = tab.tourActivity ?? [];
        const last = feed[feed.length - 1];
        // Skip blank entries and consecutive duplicates; keep the feed bounded.
        if (!entry.text.trim() || (last && last.kind === entry.kind && last.text === entry.text)) {
          return tab;
        }
        return { ...tab, tourActivity: [...feed, entry].slice(-80) };
      })
    })),
  updateReviewThread: (tabKeyToUpdate, thread) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              bundle: {
                ...tab.bundle,
                reviewThreads: tab.bundle.reviewThreads.map((candidate) =>
                  candidate.id === thread.id ? mergeReviewThread(candidate, thread) : candidate
                )
              }
            }
          : tab
      )
    })),
  appendReviewThreadComment: (tabKeyToUpdate, threadId, comment) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              bundle: {
                ...tab.bundle,
                reviewThreads: tab.bundle.reviewThreads.map((thread) =>
                  thread.id === threadId
                    ? {
                        ...thread,
                        comments: [
                          ...thread.comments,
                          {
                            ...comment,
                            threadId: comment.threadId ?? threadId,
                            path: comment.path ?? thread.path,
                            line: comment.line ?? thread.line
                          }
                        ]
                      }
                    : thread
                )
              }
            }
          : tab
      )
    })),
  updateReviewThreadComment: (tabKeyToUpdate, threadId, comment) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              bundle: {
                ...tab.bundle,
                reviewThreads: tab.bundle.reviewThreads.map((thread) =>
                  thread.id === threadId
                    ? {
                        ...thread,
                        comments: thread.comments.map((candidate) =>
                          candidate.id === comment.id
                            ? {
                                ...candidate,
                                ...comment,
                                threadId: comment.threadId ?? candidate.threadId ?? threadId,
                                path: comment.path ?? candidate.path ?? thread.path,
                                line: comment.line ?? candidate.line ?? thread.line
                              }
                            : candidate
                        )
                      }
                    : thread
                )
              }
            }
          : tab
      )
    })),
  deleteReviewThreadComment: (tabKeyToUpdate, threadId, commentId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              bundle: {
                ...tab.bundle,
                reviewThreads: tab.bundle.reviewThreads
                  .map((thread) =>
                    thread.id === threadId
                      ? {
                          ...thread,
                          comments: thread.comments.filter((comment) => comment.id !== commentId)
                        }
                      : thread
                  )
                  .filter((thread) => thread.comments.length > 0)
              }
            }
          : tab
      )
    })),
  setReviewCommentReactions: (tabKeyToUpdate, commentId, reactions) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              bundle: {
                ...tab.bundle,
                reviewThreads: tab.bundle.reviewThreads.map((thread) => ({
                  ...thread,
                  comments: thread.comments.map((comment) =>
                    comment.id === commentId ? { ...comment, reactions } : comment
                  )
                }))
              }
            }
          : tab
      )
    })),
  setActivityEventReactions: (tabKeyToUpdate, eventId, reactions) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              bundle: {
                ...tab.bundle,
                timeline: tab.bundle.timeline.map((event) =>
                  event.id === eventId ? { ...event, reactions } : event
                )
              }
            }
          : tab
      )
    })),
  setCheckout: (tabKeyToUpdate, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate ? { ...tab, checkout: { ...tab.checkout, ...patch } } : tab
      )
    })),
  dismissCheckoutBanner: (tabKeyToUpdate) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate ? { ...tab, checkout: { ...tab.checkout, dismissed: true } } : tab
      )
    })),
  setFinishOpen: (tabKeyToUpdate, open) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate ? { ...tab, finish: { ...tab.finish, open } } : tab
      )
    })),
  setFinishBody: (tabKeyToUpdate, body) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate ? { ...tab, finish: { ...tab.finish, body } } : tab
      )
    })),
  addDraftReviewComment: (tabKeyToUpdate, comment) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              finish: {
                ...tab.finish,
                comments: [
                  ...(tab.finish.comments ?? []),
                  { ...comment, id: `draft-review-comment-${++draftReviewCommentId}` }
                ]
              }
            }
          : tab
      )
    })),
  updateDraftReviewComment: (tabKeyToUpdate, commentId, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              finish: {
                ...tab.finish,
                comments: (tab.finish.comments ?? []).map((comment) =>
                  comment.id === commentId ? { ...comment, ...patch, id: comment.id } : comment
                )
              }
            }
          : tab
      )
    })),
  removeDraftReviewComment: (tabKeyToUpdate, commentId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              finish: {
                ...tab.finish,
                comments: (tab.finish.comments ?? []).filter((comment) => comment.id !== commentId)
              }
            }
          : tab
      )
    })),
  clearFinishReview: (tabKeyToUpdate) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate ? { ...tab, finish: { ...tab.finish, body: "", comments: [] } } : tab
      )
    }))
}));

export function tabKey(repository: string, number: number): string {
  return `${repository}#${number}`;
}

function firstReviewFilePath(bundle: PullRequestBundle): string | null {
  return orderChangedFilesDepthFirst(bundle.changedFiles)[0]?.path ?? null;
}

function pruneReviewedTourChapterIds(
  reviewedChapterIds: readonly string[] | undefined,
  tour: ReviewTour | null
): string[] {
  if (!tour || !reviewedChapterIds?.length) {
    return [];
  }
  const chapterIds = new Set(tour.chapters.map((chapter) => chapter.id));
  return reviewedChapterIds.filter((id) => chapterIds.has(id));
}

export function useActiveTab(): PrTab | null {
  return useUiStore((state) => state.tabs.find((tab) => tab.key === state.activeTabKey) ?? null);
}

function mergeReviewThread(existing: ReviewThread, next: ReviewThread): ReviewThread {
  return {
    ...existing,
    ...next,
    path: next.path ?? existing.path,
    line: next.line ?? existing.line,
    comments: next.comments.length > 0 ? next.comments : existing.comments
  };
}
