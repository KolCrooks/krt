// @vitest-environment node
import { describe, expect, it } from "vitest";
import { appSettingsSchema, changedFileSchema, reviewSubmissionSchema, reviewTourSchema } from "../../src/shared/schemas.js";

describe("shared schemas", () => {
  it("applies settings defaults", () => {
    const settings = appSettingsSchema.parse({
      appearance: {},
      data: {},
      ai: {},
      github: {},
      extensions: {}
    });

    expect(settings.data.preferredMode).toBe("auto");
    expect(settings.ai.provider).toBe("disabled");
    expect(settings.ai.keyProvider).toBe("keychain");
    expect(settings.github.tokenProvider).toBe("keychain");
    expect(settings.appearance.density).toBe("compact");
    expect(settings.updates).toEqual({ enabled: false, channel: "stable", feedUrl: null });
  });

  it("normalizes changed-file defaults", () => {
    const file = changedFileSchema.parse({
      path: "src/index.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      changes: 4
    });

    expect(file.reviewStatus).toBe("unreviewed");
    expect(file.annotations).toBe(0);
    expect(file.isLarge).toBe(false);
  });

  it("validates AI tour graph relationships shape", () => {
    const tour = reviewTourSchema.parse({
      id: "tour-1",
      provider: "github",
      repository: { provider: "github", owner: "o", name: "r", fullName: "o/r" },
      pullNumber: 1,
      headSha: "abc",
      generatedAt: "2026-05-22T00:00:00.000Z",
      model: "test",
      chapters: [
        {
          id: "chapter-1",
          title: "Core",
          summary: "Summary",
          files: ["src/index.ts"],
          changeStats: { additions: 1, deletions: 0, files: 1 },
          riskLevel: "low",
          generatedAt: "2026-05-22T00:00:00.000Z",
          model: "test",
          headSha: "abc"
        }
      ],
      graph: {
        nodes: [{ id: "chapter-1", label: "Core", riskLevel: "low", files: ["src/index.ts"] }],
        edges: []
      },
      riskSignals: []
    });

    expect(tour.chapters[0].diffAnchors).toEqual([]);
  });

  it("defaults review submission body and draft comments", () => {
    const submission = reviewSubmissionSchema.parse({
      repository: { provider: "github", owner: "o", name: "r", fullName: "o/r" },
      pullNumber: 1,
      event: "approve"
    });

    expect(submission.body).toBe("");
    expect(submission.comments).toEqual([]);
  });
});
