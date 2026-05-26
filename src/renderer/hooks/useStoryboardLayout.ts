import { useEffect, useMemo, useState } from "react";
import type { ReviewTour } from "../../shared/schemas.js";
import {
  buildStoryboardLayout,
  type StoryboardLayout,
  type StoryboardLayoutOptions
} from "../../shared/storyboardLayout.js";

interface UseStoryboardLayoutOptions {
  workerThreshold?: number;
  layout?: Partial<StoryboardLayoutOptions>;
}

interface StoryboardLayoutHookResult {
  layout: StoryboardLayout | null;
  isLayingOut: boolean;
  usedWorker: boolean;
}

interface WorkerResponse {
  id: number;
  result?: StoryboardLayout;
  error?: string;
}

let requestId = 0;

export function useStoryboardLayout(
  tour: ReviewTour | null,
  options: UseStoryboardLayoutOptions = {}
): StoryboardLayoutHookResult {
  const workerThreshold = options.workerThreshold ?? 40;
  const shouldUseWorker = Boolean(tour && tour.graph.nodes.length >= workerThreshold && typeof Worker !== "undefined");
  const [workerResult, setWorkerResult] = useState<StoryboardLayout | null>(null);

  const syncResult = useMemo(
    () => (tour && !shouldUseWorker ? buildStoryboardLayout(tour, options.layout) : null),
    [options.layout, shouldUseWorker, tour]
  );

  useEffect(() => {
    if (!tour || !shouldUseWorker) {
      setWorkerResult(null);
      return undefined;
    }

    const worker = createStoryboardLayoutWorker();
    if (!worker) {
      setWorkerResult(buildStoryboardLayout(tour, options.layout));
      return undefined;
    }

    const id = requestId + 1;
    requestId = id;
    setWorkerResult(null);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) {
        return;
      }
      setWorkerResult(event.data.result ?? buildStoryboardLayout(tour, options.layout));
      worker.terminate();
    };
    worker.onerror = () => {
      setWorkerResult(buildStoryboardLayout(tour, options.layout));
      worker.terminate();
    };
    worker.postMessage({ id, tour, options: options.layout });

    return () => worker.terminate();
  }, [options.layout, shouldUseWorker, tour]);

  return {
    layout: syncResult ?? workerResult,
    isLayingOut: shouldUseWorker && !workerResult,
    usedWorker: shouldUseWorker
  };
}

function createStoryboardLayoutWorker(): Worker | null {
  try {
    return new Worker(new URL("../workers/storyboardLayout.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}
