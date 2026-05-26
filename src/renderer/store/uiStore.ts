import { create } from "zustand";
import type {
  DataMode,
  PullRequestBundle,
  PullRequestSummary,
  ReviewComment,
  ReviewThread,
  ReviewTour
} from "../../shared/schemas.js";

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
  viewMode: TabViewMode;
  reviewSubMode: ReviewSubMode;
  checkout: TabCheckout;
  finish: TabFinishReview;
}

const defaultCheckout: TabCheckout = {
  state: "idle",
  dismissed: false,
  message: null,
  percent: null,
  operationId: null
};

const defaultFinish: TabFinishReview = { open: false, body: "" };

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
  openFileInTab: (tabKey: string, path: string) => void;
  setTour: (tabKey: string, tour: ReviewTour) => void;
  updateReviewThread: (tabKey: string, thread: ReviewThread) => void;
  appendReviewThreadComment: (tabKey: string, threadId: string, comment: ReviewComment) => void;
  setCheckout: (tabKey: string, patch: Partial<TabCheckout>) => void;
  dismissCheckoutBanner: (tabKey: string) => void;
  setFinishOpen: (tabKey: string, open: boolean) => void;
  setFinishBody: (tabKey: string, body: string) => void;
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
      const tab: PrTab = {
        key,
        title: bundle.detail.title,
        repository: bundle.detail.repository.fullName,
        number: bundle.detail.number,
        mode: bundle.mode,
        bundle,
        selectedFilePath: bundle.changedFiles[0]?.path ?? null,
        openFilePaths: [],
        tour: null,
        viewMode: "overview",
        reviewSubMode: "diff",
        checkout: { ...defaultCheckout },
        finish: { ...defaultFinish }
      };

      return {
        tabs: existing
          ? state.tabs.map((candidate) =>
              candidate.key === key
                ? { ...candidate, ...tab, tour: candidate.tour, viewMode: candidate.viewMode, reviewSubMode: candidate.reviewSubMode, checkout: candidate.checkout, finish: candidate.finish }
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
      tabs: state.tabs.map((tab) => (tab.key === tabKeyToUpdate ? { ...tab, viewMode } : tab))
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
            : bundle.changedFiles[0]?.path ?? null;
          const openFilePaths = tab.openFilePaths.filter((path) => bundle.changedFiles.some((file) => file.path === path));
          const headShaChanged = tab.bundle.detail.headSha !== bundle.detail.headSha;
          return {
            ...tab,
            title: bundle.detail.title,
            mode: bundle.mode,
            bundle,
            selectedFilePath,
            openFilePaths: openFilePaths.length > 0 ? openFilePaths : selectedFilePath ? [selectedFilePath] : [],
            tour: headShaChanged ? null : tab.tour
          };
        })
      };
    }),
  selectFile: (tabKeyToUpdate, path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate ? { ...tab, selectedFilePath: path } : tab
      )
    })),
  openFileInTab: (tabKeyToUpdate, path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.key === tabKeyToUpdate
          ? {
              ...tab,
              selectedFilePath: path,
              openFilePaths: tab.openFilePaths.includes(path) ? tab.openFilePaths : [...tab.openFilePaths, path]
            }
          : tab
      )
    })),
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
            ? openFilePaths[Math.max(0, index - 1)] ?? openFilePaths[0] ?? tab.bundle.changedFiles[0]?.path ?? null
            : tab.selectedFilePath;

        return {
          ...tab,
          selectedFilePath,
          openFilePaths
        };
      })
    })),
  setTour: (tabKeyToUpdate, tour) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.key === tabKeyToUpdate ? { ...tab, tour } : tab))
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
    }))
}));

export function tabKey(repository: string, number: number): string {
  return `${repository}#${number}`;
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
