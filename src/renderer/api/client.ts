import type { IpcInput } from "../../shared/ipc.js";
import { createBrowserPreviewApi } from "./browserPreview.js";

const api = window.krt ?? (import.meta.env.DEV ? createBrowserPreviewApi() : null);

if (!api) {
  throw new Error("KRT preload API is unavailable.");
}

export const krtClient = api;

export type SearchPullRequestsInput = IpcInput<"pullRequests:search">;
