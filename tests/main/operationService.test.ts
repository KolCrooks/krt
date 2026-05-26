// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/main/errors.js";
import { OperationService } from "../../src/main/services/operationService.js";

describe("OperationService", () => {
  it("cancels tracked operations through an abort signal", () => {
    const service = new OperationService();
    const operationId = service.create("checkout", "Starting checkout");

    const progress = service.cancel(operationId);

    expect(progress?.cancelled).toBe(true);
    expect(service.signal(operationId)?.aborted).toBe(true);
    expect(() => service.assertNotCancelled(operationId)).toThrow(AppError);
  });

  it("marks cancelled operations as done when they fail out of async work", () => {
    const service = new OperationService();
    const operationId = service.create("checkout", "Starting checkout");
    service.cancel(operationId);

    service.markFailed(operationId, "Managed checkout was cancelled", "abort");

    expect(service.get(operationId)).toMatchObject({
      phase: "cancelled",
      done: true,
      cancelled: true,
      error: "abort"
    });
  });
});
