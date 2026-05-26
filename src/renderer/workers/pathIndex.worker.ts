import { buildPathIndexAsync, type PathIndexProgress, type PathIndexRequest } from "../../shared/pathIndex.js";

interface PathIndexWorkerIndexRequest {
  type: "index";
  id: number;
  input: PathIndexRequest;
}

interface PathIndexWorkerCancelRequest {
  type: "cancel";
  id: number;
}

type PathIndexWorkerRequest = PathIndexWorkerIndexRequest | PathIndexWorkerCancelRequest;

const controllers = new Map<number, AbortController>();
const pendingCancels = new Set<number>();

self.onmessage = (event: MessageEvent<PathIndexWorkerRequest>) => {
  if (event.data.type === "cancel") {
    pendingCancels.add(event.data.id);
    controllers.get(event.data.id)?.abort();
    return;
  }

  void indexPaths(event.data);
};

async function indexPaths(request: PathIndexWorkerIndexRequest): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.id, controller);
  if (pendingCancels.delete(request.id)) {
    controller.abort();
  }

  try {
    const result = await buildPathIndexAsync(request.input, {
      signal: controller.signal,
      onProgress: (progress: PathIndexProgress) => {
        self.postMessage({
          id: request.id,
          progress
        });
      }
    });
    self.postMessage({
      id: request.id,
      result
    });
  } catch (error) {
    self.postMessage({
      id: request.id,
      cancelled: error instanceof DOMException && error.name === "AbortError",
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    controllers.delete(request.id);
  }
}
