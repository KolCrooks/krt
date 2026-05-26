import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { operationProgressEvent } from "../../shared/ipc.js";
import type { OperationProgress } from "../../shared/schemas.js";
import { AppError } from "../errors.js";

export class OperationService {
  private readonly progress = new Map<string, OperationProgress>();
  private readonly controllers = new Map<string, AbortController>();
  private windows = new Set<BrowserWindow>();

  attachWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on("closed", () => this.windows.delete(window));
  }

  create(phase: string, message: string): string {
    const operationId = randomUUID();
    this.controllers.set(operationId, new AbortController());
    this.update({ operationId, phase, message, percent: 0, done: false, cancelled: false });
    return operationId;
  }

  update(progress: OperationProgress): void {
    if (progress.done) {
      this.controllers.delete(progress.operationId);
    }
    this.progress.set(progress.operationId, progress);
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(operationProgressEvent, progress);
      }
    }
  }

  get(operationId: string): OperationProgress | null {
    return this.progress.get(operationId) ?? null;
  }

  snapshot(limit = 20): OperationProgress[] {
    return [...this.progress.values()].slice(-limit).reverse();
  }

  signal(operationId: string): AbortSignal | undefined {
    return this.controllers.get(operationId)?.signal;
  }

  cancel(operationId: string): OperationProgress | null {
    const current = this.progress.get(operationId);
    const controller = this.controllers.get(operationId);
    if (!current) {
      return null;
    }

    if (controller && !controller.signal.aborted) {
      controller.abort();
    }

    const cancelled = {
      ...current,
      phase: "cancelled",
      message: "Cancellation requested",
      cancelled: true,
      done: current.done
    };
    this.update(cancelled);
    return cancelled;
  }

  assertNotCancelled(operationId: string): void {
    if (this.controllers.get(operationId)?.signal.aborted) {
      throw new AppError("operation_cancelled", "The operation was cancelled.", { retryable: true });
    }
  }

  markFailed(operationId: string, message: string, error?: string): void {
    const current = this.progress.get(operationId);
    this.update({
      operationId,
      phase: current?.cancelled ? "cancelled" : "failed",
      message,
      percent: current?.percent ?? null,
      done: true,
      cancelled: current?.cancelled ?? false,
      error
    });
  }
}
