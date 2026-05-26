import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from "@pierre/diffs/react";
import type { ReactNode } from "react";

const DIFF_WORKER_AST_CACHE_SIZE = 160;
const DIFF_WORKER_PRELOADED_LANGUAGES = [
  "rust",
  "toml",
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "yaml",
  "markdown"
] as const;

const diffWorkerHighlighterOptions: WorkerInitializationRenderOptions = {
  langs: [...DIFF_WORKER_PRELOADED_LANGUAGES],
  preferredHighlighter: "shiki-js",
  tokenizeMaxLineLength: 600,
  useTokenTransformer: true
};

const diffWorkerPoolOptions: WorkerPoolOptions = {
  workerFactory: createDiffWorker,
  poolSize: getDiffWorkerPoolSize(),
  totalASTLRUCacheSize: DIFF_WORKER_AST_CACHE_SIZE
};

interface DiffWorkerPoolProviderProps {
  children: ReactNode;
}

export function DiffWorkerPoolProvider({ children }: DiffWorkerPoolProviderProps): React.JSX.Element {
  if (!canUseDiffWorkerPool()) {
    return <>{children}</>;
  }

  return (
    <WorkerPoolContextProvider poolOptions={diffWorkerPoolOptions} highlighterOptions={diffWorkerHighlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}

function createDiffWorker(): Worker {
  return new Worker(new URL("@pierre/diffs/worker/worker-portable.js", import.meta.url), {
    name: "pierre-diffs",
    type: "module"
  });
}

function getDiffWorkerPoolSize(): number {
  const coreCount = globalThis.navigator?.hardwareConcurrency ?? 2;
  if (coreCount <= 4) {
    return 2;
  }
  return Math.min(4, Math.max(2, Math.floor(coreCount / 2)));
}

function canUseDiffWorkerPool(): boolean {
  return typeof window !== "undefined" && typeof window.Worker === "function";
}
