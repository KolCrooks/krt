import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiProcessingChip } from "../../src/renderer/components/review/AiProcessingChip.js";
import type { PrTab } from "../../src/renderer/store/uiStore.js";

function tabWith(overrides: Partial<PrTab>): PrTab {
  return {
    tourOperationId: null,
    tourProgress: null,
    tourActivity: [],
    ...overrides
  } as unknown as PrTab;
}

describe("AiProcessingChip", () => {
  it("renders nothing when no generation is in flight", () => {
    const { container } = render(<AiProcessingChip tab={tabWith({})} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows an animated chip with the latest activity and elapsed thinking time while generating", () => {
    render(
      <AiProcessingChip
        tab={tabWith({
          tourOperationId: "op-1",
          tourProgress: { operationId: "op-1", phase: "activity", message: "Reading src/App.tsx", percent: 47, done: false, cancelled: false },
          tourStartedAt: Date.now() - 65_000,
          tourActivity: [{ kind: "tool", text: "Commenting on src/App.tsx" }]
        })}
      />
    );
    const chip = screen.getByRole("button", { name: /AI review in progress/i });
    expect(chip).toHaveTextContent("Commenting on src/App.tsx");
    // Elapsed "thinking" time replaces the now-meaningless percent (m:ss).
    expect(chip).toHaveTextContent(/\d+:\d{2}/);
  });

  it("hides once the operation is done", () => {
    const { container } = render(
      <AiProcessingChip
        tab={tabWith({
          tourOperationId: "op-1",
          tourProgress: { operationId: "op-1", phase: "complete", message: "done", percent: 100, done: true, cancelled: false }
        })}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});
