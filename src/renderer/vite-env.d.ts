/// <reference types="vite/client" />

import type { KrtApi } from "../preload/index.js";

declare global {
  interface Window {
    krt: KrtApi;
  }
}
