// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAiReviewPrompt, prepareAiReviewContext, type PreparedAiReviewContext } from "../../src/shared/aiPrompt.js";
import type { ChangedFile, PullRequestDetail } from "../../src/shared/schemas.js";

const pullRequest: PullRequestDetail = {
  provider: "github",
  id: "1",
  number: 42,
  repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" },
  title: "Large review target",
  state: "open",
  draft: false,
  url: "https://github.com/kol/repo/pull/42",
  author: { login: "kol" },
  labels: [],
  reviewers: [],
  baseRef: "main",
  headRef: "feature",
  headSha: "abcdef123",
  baseSha: "123abcdef",
  additions: 50_000,
  deletions: 50_000,
  changedFileCount: 1_000,
  commentCount: 0,
  updatedAt: "2026-05-22T00:00:00.000Z",
  createdAt: "2026-05-22T00:00:00.000Z",
  body: "Synthetic large PR.",
  isFromFork: false
};

describe("AI prompt preparation", () => {
  it("bounds prompt size for a synthetic 1k-file and 100k-line PR", () => {
    const changedFiles = Array.from({ length: 1_000 }, (_value, index) =>
      changedFile(`packages/pkg-${String(index % 50).padStart(2, "0")}/src/file-${String(index).padStart(4, "0")}.ts`, {
        additions: 50,
        deletions: 50,
        patch: syntheticPatch(index)
      })
    );

    const startedAt = performance.now();
    const prompt = buildAiReviewPrompt({
      pullRequest,
      changedFiles,
      timeline: [],
      reviewThreads: [],
      checks: [{ id: "check", provider: "github", name: "test", status: "completed", conclusion: "failure" }]
    });
    const durationMs = performance.now() - startedAt;
    const context = JSON.parse(prompt) as PreparedAiReviewContext;

    expect(context.summary).toMatchObject({
      totalFiles: 1_000,
      includedFiles: 120,
      omittedFiles: 880,
      changedLines: 100_000,
      failingChecks: 1
    });
    expect(context.clusters.length).toBeLessThanOrEqual(12);
    expect(context.clusters.flatMap((cluster) => cluster.files)).toHaveLength(120);
    expect(totalPatchChars(context)).toBeLessThanOrEqual(60_000);
    expect(prompt.length).toBeLessThan(120_000);
    expect(durationMs).toBeLessThan(1_000);
  });

  it("prioritizes high-signal files before low-risk alphabetical order", () => {
    const context = prepareAiReviewContext(
      {
        pullRequest,
        changedFiles: [
          changedFile("aaa/low.ts", { additions: 1, deletions: 0 }),
          changedFile("zzz/diagnostic.ts", { additions: 1, deletions: 0, diagnostics: 4 })
        ],
        timeline: [],
        reviewThreads: [],
        checks: []
      },
      { maxFiles: 1 }
    );

    expect(context.clusters[0].files[0].path).toBe("zzz/diagnostic.ts");
    expect(context.summary.omittedFiles).toBe(1);
  });

  it("extracts dependency signals without exceeding per-file import limits", () => {
    const context = prepareAiReviewContext({
      pullRequest,
      changedFiles: [
        changedFile("src/App.tsx", {
          additions: 5,
          deletions: 0,
          patch: [
            "+import React from 'react';",
            "+import { QueryClient } from '@tanstack/react-query';",
            "+const lazy = import('lazy-module');",
            "+const fs = require('node:fs');",
            "+from package.module import thing",
            "+use crate::review::Tour;"
          ].join("\n")
        })
      ],
      timeline: [],
      reviewThreads: [],
      checks: []
    });

    expect(context.clusters[0].dependencies).toEqual([
      "react",
      "@tanstack/react-query",
      "lazy-module",
      "node:fs",
      "package.module",
      "crate::review::Tour"
    ]);
  });

  it("includes tour-specific generation instructions in the prompt context", () => {
    const context = prepareAiReviewContext({
      pullRequest,
      changedFiles: [changedFile("src/App.tsx", { additions: 5, deletions: 1 })],
      timeline: [],
      reviewThreads: [],
      checks: []
    });

    expect(context.task.role).toContain("senior code reviewer");
    expect(context.task.outputRequirements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Return exactly one JSON object"),
        expect.stringContaining("topic clusters"),
        expect.stringContaining("Do not invent files")
      ])
    );
    expect(context.task.chapterGuidance).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reviewer should follow"),
        expect.stringContaining("Do not create one chapter per file"),
        expect.stringContaining("not 'SettingsView.tsx' or 'src/ changes'")
      ])
    );
    expect(context.task.riskGuidance).toEqual(expect.arrayContaining([expect.stringContaining("failing checks")]));
    expect(context.schema).toContain("Required chapter fields");
  });

  it("groups cross-cutting changes by review topic instead of file directory", () => {
    const context = prepareAiReviewContext({
      pullRequest,
      changedFiles: [
        changedFile("src/shared/schemas.ts", {
          patch: '+ keyProvider: aiKeyProviderSchema.default("keychain")'
        }),
        changedFile("src/main/services/keychain.ts", {
          patch: '+ return execFileAsync("gh", ["auth", "token"]);'
        }),
        changedFile("src/renderer/components/SettingsView.tsx", {
          patch: "+ <select value={settings.github.tokenProvider}>"
        }),
        changedFile("tests/main/providerRegistry.test.ts", {
          patch: '+ expect(registry.getGitHubToken()).resolves.toBe("gh-cli-token");'
        })
      ],
      timeline: [],
      reviewThreads: [],
      checks: []
    });

    const settingsCluster = context.clusters.find((cluster) => cluster.topic === "settings-credentials");
    expect(settingsCluster?.title).toBe("Settings and credential provider flow");
    expect(settingsCluster?.files.map((file) => file.path).sort()).toEqual([
      "src/main/services/keychain.ts",
      "src/renderer/components/SettingsView.tsx",
      "src/shared/schemas.ts"
    ]);
    expect(context.clusters.some((cluster) => cluster.title.endsWith("/ changes"))).toBe(false);
    expect(context.clusters.find((cluster) => cluster.topic === "tests-validation")?.files.map((file) => file.path)).toEqual([
      "tests/main/providerRegistry.test.ts"
    ]);
  });
});

function changedFile(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  const additions = overrides.additions ?? 1;
  const deletions = overrides.deletions ?? 0;
  return {
    path,
    status: overrides.status ?? "modified",
    additions,
    deletions,
    changes: overrides.changes ?? additions + deletions,
    patch: overrides.patch,
    language: overrides.language ?? "typescript",
    isLarge: overrides.isLarge ?? false,
    isGenerated: overrides.isGenerated ?? false,
    reviewStatus: overrides.reviewStatus ?? "unreviewed",
    annotations: overrides.annotations ?? 0,
    diagnostics: overrides.diagnostics ?? 0
  };
}

function syntheticPatch(index: number): string {
  const lines = Array.from({ length: 100 }, (_value, line) => `+export const value${index}_${line} = "${"x".repeat(80)}";`);
  return ["@@ -1,50 +1,50 @@", ...lines].join("\n");
}

function totalPatchChars(context: PreparedAiReviewContext): number {
  return context.clusters
    .flatMap((cluster) => cluster.files)
    .reduce((sum, file) => sum + (file.patchExcerpt?.length ?? 0), 0);
}
