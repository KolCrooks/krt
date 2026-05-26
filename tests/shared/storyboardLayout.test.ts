// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildStoryboardLayout } from "../../src/shared/storyboardLayout.js";
import type { ReviewTour } from "../../src/shared/schemas.js";

describe("buildStoryboardLayout", () => {
  it("places dependent chapters later in the horizontal flow", () => {
    const tour = tourWithChapters(3);
    const layout = buildStoryboardLayout(tour);

    const first = layout.nodes.find((node) => node.id === "chapter-1");
    const second = layout.nodes.find((node) => node.id === "chapter-2");
    const third = layout.nodes.find((node) => node.id === "chapter-3");

    expect(first?.x).toBeLessThan(second?.x ?? 0);
    expect(second?.x).toBeLessThan(third?.x ?? 0);
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges[0]?.path).toContain("C");
  });

  it("falls back to chapter dependencies when graph edges are missing", () => {
    const tour = {
      ...tourWithChapters(2),
      graph: {
        nodes: [
          { id: "chapter-1", label: "Chapter 1", riskLevel: "low" as const, files: ["src/file-1.ts"] },
          { id: "chapter-2", label: "Chapter 2", riskLevel: "medium" as const, files: ["src/file-2.ts"] }
        ],
        edges: []
      }
    };
    const layout = buildStoryboardLayout(tour);

    expect(layout.nodes.find((node) => node.id === "chapter-1")?.x).toBeLessThan(
      layout.nodes.find((node) => node.id === "chapter-2")?.x ?? 0
    );
  });

  it("uses simplified dimensions for large tour graphs", () => {
    const layout = buildStoryboardLayout(tourWithChapters(80));

    expect(layout.simplified).toBe(true);
    expect(layout.nodes).toHaveLength(80);
    expect(layout.nodes[0]?.width).toBeLessThan(180);
  });
});

function tourWithChapters(count: number): ReviewTour {
  const chapters = Array.from({ length: count }, (_value, index) => {
    const chapterNumber = index + 1;
    return {
      id: `chapter-${chapterNumber}`,
      title: `Chapter ${chapterNumber}`,
      summary: `Summary ${chapterNumber}`,
      files: [`src/file-${chapterNumber}.ts`],
      diffAnchors: [{ path: `src/file-${chapterNumber}.ts`, side: "right" as const }],
      changeStats: { additions: chapterNumber, deletions: 0, files: 1 },
      riskLevel: chapterNumber % 3 === 0 ? ("high" as const) : chapterNumber % 2 === 0 ? ("medium" as const) : ("low" as const),
      riskReasons: [],
      reviewChecklist: [],
      dependencies: chapterNumber > 1 ? [`chapter-${chapterNumber - 1}`] : [],
      generatedAt: "2026-05-22T00:00:00.000Z",
      model: "test",
      headSha: "abc123"
    };
  });

  return {
    id: "tour",
    provider: "github",
    repository: {
      provider: "github",
      owner: "kol",
      name: "repo",
      fullName: "kol/repo"
    },
    pullNumber: 12,
    headSha: "abc123",
    generatedAt: "2026-05-22T00:00:00.000Z",
    model: "test",
    chapters,
    graph: {
      nodes: chapters.map((chapter) => ({
        id: chapter.id,
        label: chapter.title,
        riskLevel: chapter.riskLevel,
        files: chapter.files
      })),
      edges: chapters.slice(1).map((chapter, index) => ({
        id: `edge-${index + 1}`,
        from: `chapter-${index + 1}`,
        to: chapter.id,
        relation: "dependency" as const,
        confidence: 0.8,
        source: "deterministic" as const
      }))
    },
    riskSignals: []
  };
}
