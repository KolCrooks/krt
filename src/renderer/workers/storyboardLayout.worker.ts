import { buildStoryboardLayout, type StoryboardLayoutOptions } from "../../shared/storyboardLayout.js";
import type { ReviewTour } from "../../shared/schemas.js";

interface StoryboardLayoutWorkerRequest {
  id: number;
  tour: ReviewTour;
  options?: Partial<StoryboardLayoutOptions>;
}

self.onmessage = (event: MessageEvent<StoryboardLayoutWorkerRequest>) => {
  try {
    self.postMessage({
      id: event.data.id,
      result: buildStoryboardLayout(event.data.tour, event.data.options)
    });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
