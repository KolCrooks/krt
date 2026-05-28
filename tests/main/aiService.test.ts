// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/main/services/database.js";
import { AiService } from "../../src/main/services/aiService.js";
import { Keychain } from "../../src/main/services/keychain.js";
import { defaultAppSettings, type PullRequestDetail } from "../../src/shared/schemas.js";
import { AppError } from "../../src/main/errors.js";

const pullRequest: PullRequestDetail = {
  provider: "github",
  id: "1",
  number: 42,
  repository: { provider: "github", owner: "kol", name: "repo", fullName: "kol/repo" },
  title: "Add review workspace",
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
  additions: 10,
  deletions: 2,
  changedFileCount: 1,
  commentCount: 0,
  updatedAt: "2026-05-22T00:00:00.000Z",
  createdAt: "2026-05-22T00:00:00.000Z",
  body: "Implements the workspace",
  isFromFork: false
};

describe("AiService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an error instead of falling back when AI is disabled", async () => {
    const db = openDatabase(":memory:");
    const service = new AiService(db, new Keychain("test"), () => defaultAppSettings);

    await expect(
      service.generateTour({
        pullRequest,
        changedFiles: [
          {
            path: "src/App.tsx",
            status: "modified",
            additions: 10,
            deletions: 2,
            changes: 12,
            isLarge: false,
            isGenerated: false,
            reviewStatus: "unreviewed",
            annotations: 0,
            diagnostics: 0
          }
        ],
        timeline: [],
        reviewThreads: [],
        checks: []
      })
    ).rejects.toMatchObject({ code: "ai_disabled" });
    expect(service.getCachedTour(pullRequest.repository, pullRequest.number, pullRequest.headSha)).toBeNull();
  });

  it("reports an error when a configured provider request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }) as Response)
    );
    const service = configuredAiService("anthropic", "claude-sonnet-4-5");

    await expect(service.generateTour(aiInput())).rejects.toMatchObject({ code: "ai_provider_error" });
  });

  it("re-requests the provider when forced even if a cached tour exists", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: providerTourJson() }] })
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredAiService("anthropic", "claude-sonnet-4-5");

    await service.generateTour(aiInput());
    await service.generateTour({ ...aiInput(), force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redacts prompt input before calling a configured AI provider", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: false }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = new AiService(
      openDatabase(":memory:"),
      { getSecret: vi.fn(async () => "test-ai-key") } as unknown as Keychain,
      () => ({
        ...defaultAppSettings,
        ai: {
          ...defaultAppSettings.ai,
          enabled: true,
          provider: "openai",
          model: "gpt-5-mini"
        }
      })
    );

    await expect(
      service.generateTour({
        pullRequest: {
          ...pullRequest,
          body: "Use Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456"
        },
        changedFiles: [
          {
            path: "src/secrets.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "+ const apiKey = 'sk-project_abcdefghijklmnopqrstuvwxyz123456';",
            isLarge: false,
            isGenerated: false,
            reviewStatus: "unreviewed",
            annotations: 0,
            diagnostics: 0
          }
        ],
        timeline: [
          {
            id: "event",
            kind: "comment",
            title: "token=super-secret-value",
            createdAt: "2026-05-22T00:00:00.000Z",
            severity: "info",
            reactions: []
          }
        ],
        reviewThreads: [],
        checks: []
      })
    ).rejects.toMatchObject({ code: "ai_provider_error" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";

    expect(prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(prompt).not.toContain("sk-project_abcdefghijklmnopqrstuvwxyz123456");
    expect(prompt).not.toContain("super-secret-value");
    expect(prompt).toContain("[REDACTED_AUTH_HEADER]");
    expect(prompt).toContain("[REDACTED_SECRET]");
  });

  it("loads an API key from a configured command provider", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: false }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const getCommandSecret = vi.fn(async () => "cmd-ai-key");
    const service = new AiService(
      openDatabase(":memory:"),
      {
        getSecret: vi.fn(async () => null),
        getCommandSecret
      } as unknown as Keychain,
      () => ({
        ...defaultAppSettings,
        ai: {
          ...defaultAppSettings.ai,
          enabled: true,
          provider: "openai",
          model: "gpt-5-mini",
          keyProvider: "command",
          keyCommand: "security find-generic-password -w"
        }
      })
    );

    await expect(
      service.generateTour({
        pullRequest,
        changedFiles: [
          {
            path: "src/App.tsx",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            isLarge: false,
            isGenerated: false,
            reviewStatus: "unreviewed",
            annotations: 0,
            diagnostics: 0
          }
        ],
        timeline: [],
        reviewThreads: [],
        checks: []
      })
    ).rejects.toMatchObject({ code: "ai_provider_error" });

    expect(getCommandSecret).toHaveBeenCalledWith("security find-generic-password -w");
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request?.headers).toMatchObject({
      authorization: "Bearer cmd-ai-key"
    });
  });

  it("honors an aborted generation signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new AiService(openDatabase(":memory:"), new Keychain("test"), () => defaultAppSettings);

    await expect(
      service.generateTour(
        {
          pullRequest,
          changedFiles: [],
          timeline: [],
          reviewThreads: [],
          checks: []
        },
        { signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(AppError);
  });

  it("generates a tour with Anthropic Messages API responses", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: providerTourJson() }]
      })
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredAiService("anthropic", "claude-sonnet-4-5");

    const tour = await service.generateTour(aiInput());

    expect(tour.model).toBe("claude-sonnet-4-5");
    expect(tour.chapters[0]?.title).toBe("Provider chapter");
    const [endpoint, request] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(endpoint)).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers).toMatchObject({
      "x-api-key": "test-ai-key",
      "anthropic-version": "2023-06-01"
    });
  });

  it("streams partial tours as chapters arrive, then returns the full tour", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: anthropicSseStream(twoChapterTourJson(), 24)
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredAiService("anthropic", "claude-sonnet-4-5");

    const streamedChapterCounts: number[] = [];
    const tour = await service.generateTour(aiInput(), {
      onProgress: (progress) => {
        if (progress.tour) {
          streamedChapterCounts.push(progress.tour.chapters.length);
        }
      }
    });

    // Final tour is fully parsed with both chapters and the graph edge.
    expect(tour.chapters).toHaveLength(2);
    expect(tour.graph.edges).toHaveLength(1);
    // The UI received the story incrementally: one chapter before two.
    expect(streamedChapterCounts).toContain(1);
    expect(Math.max(...streamedChapterCounts)).toBe(2);
    expect(streamedChapterCounts).toEqual([...streamedChapterCounts].sort((a, b) => a - b));
  });

  it("salvages chapters when the model's graph deviates from the schema", async () => {
    const deviantTour = JSON.parse(twoChapterTourJson()) as Record<string, unknown>;
    // Model emits out-of-enum relation/source and a percentage confidence, plus a
    // risk signal with an invalid level — strict parsing of the whole tour fails.
    (deviantTour as { graph: { edges: unknown[] } }).graph.edges = [
      { id: "edge-1", from: "chapter-1", to: "chapter-2", relation: "depends_on", confidence: 80, source: "model" }
    ];
    (deviantTour as { riskSignals: unknown[] }).riskSignals = [
      { id: "risk-1", level: "critical", title: "bad", files: [], reason: "invalid level" }
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: JSON.stringify(deviantTour) }] })
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredAiService("anthropic", "claude-sonnet-4-5");

    const tour = await service.generateTour(aiInput());

    expect(tour.chapters).toHaveLength(2);
    // The bad edge is coerced into a valid relation, confidence, and source.
    expect(tour.graph.edges).toEqual([
      expect.objectContaining({ from: "chapter-1", to: "chapter-2", relation: "dependency", confidence: 0.8, source: "ai" })
    ]);
    // The invalid risk signal is dropped rather than failing the whole tour.
    expect(tour.riskSignals).toEqual([]);
  });

  it("salvages complete chapters when the streamed JSON is truncated", async () => {
    const full = twoChapterTourJson();
    // Drop everything from the graph onward, as if the response was cut off.
    const truncated = full.slice(0, full.indexOf('],"graph"') + 1);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: truncated }] })
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredAiService("anthropic", "claude-sonnet-4-5");

    const tour = await service.generateTour(aiInput());

    expect(tour.chapters).toHaveLength(2);
    expect(tour.graph.nodes).toHaveLength(2);
    expect(tour.graph.edges).toEqual([]);
  });

  it("asks the model to correct an unparseable response instead of regenerating", async () => {
    const responses = [
      // First response is not a tour at all — nothing to salvage.
      { content: [{ type: "text", text: "Sure! Here is the review tour you asked for." }] },
      // Correction round returns a valid tour.
      { content: [{ type: "text", text: twoChapterTourJson() }] }
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift() ?? responses[responses.length - 1]
    }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredAiService("anthropic", "claude-sonnet-4-5");

    const tour = await service.generateTour(aiInput());

    expect(tour.chapters).toHaveLength(2);
    // One generation call + one correction call — not a second full generation.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The correction request disables thinking and streaming.
    const correctionCall = fetchMock.mock.calls[1] as unknown as [unknown, RequestInit];
    const correctionBody = JSON.parse(String(correctionCall[1]?.body)) as { thinking?: unknown; stream?: unknown };
    expect(correctionBody.thinking).toBeUndefined();
    expect(correctionBody.stream).toBeUndefined();
  });

  it("generates a tour with Google Gemini generateContent responses", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: providerTourJson() }] } }]
      })
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = configuredAiService("google", "gemini-2.5-flash");

    const tour = await service.generateTour(aiInput());

    expect(tour.model).toBe("gemini-2.5-flash");
    expect(tour.chapters[0]?.files).toEqual(["src/App.tsx"]);
    const [endpoint, request] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(endpoint)).toContain("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(String(endpoint)).toContain("key=test-ai-key");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json"
      }
    });
  });

  it("generates a tour with Azure OpenAI chat completion responses", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: providerTourJson() } }]
      })
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = new AiService(
      openDatabase(":memory:"),
      { getSecret: vi.fn(async () => "test-ai-key") } as unknown as Keychain,
      () => ({
        ...defaultAppSettings,
        ai: {
          ...defaultAppSettings.ai,
          enabled: true,
          provider: "azure-openai",
          model: "review-deployment",
          baseUrl: "https://krt-openai.openai.azure.com"
        }
      })
    );

    const tour = await service.generateTour(aiInput());

    expect(tour.model).toBe("review-deployment");
    const [endpoint, request] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(endpoint)).toBe(
      "https://krt-openai.openai.azure.com/openai/deployments/review-deployment/chat/completions?api-version=2024-10-21"
    );
    expect(request?.headers).toMatchObject({
      "api-key": "test-ai-key"
    });
  });

  it("generates a tour with signed Bedrock Converse responses", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        output: { message: { content: [{ text: providerTourJson() }] } }
      })
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const service = new AiService(
      openDatabase(":memory:"),
      {
        getSecret: vi.fn(async () =>
          JSON.stringify({
            accessKeyId: "AKIAIOSFODNN7EXAMPLE",
            secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            sessionToken: "session-token",
            region: "us-west-2"
          })
        )
      } as unknown as Keychain,
      () => ({
        ...defaultAppSettings,
        ai: {
          ...defaultAppSettings.ai,
          enabled: true,
          provider: "bedrock",
          model: "anthropic.claude-3-5-sonnet-20241022-v2:0"
        }
      })
    );

    const tour = await service.generateTour(aiInput());

    expect(tour.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    const [endpoint, request] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(String(endpoint)).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse"
    );
    expect(request?.headers).toMatchObject({
      "content-type": "application/json",
      "x-amz-security-token": "session-token"
    });
    expect((request?.headers as Record<string, string>).authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      messages: [{ role: "user" }]
    });
  });
});

function configuredAiService(provider: "anthropic" | "google", model: string): AiService {
  return new AiService(
    openDatabase(":memory:"),
    { getSecret: vi.fn(async () => "test-ai-key") } as unknown as Keychain,
    () => ({
      ...defaultAppSettings,
      ai: {
        ...defaultAppSettings.ai,
        enabled: true,
        provider,
        model
      }
    })
  );
}

function aiInput() {
  return {
    pullRequest,
    changedFiles: [
      {
        path: "src/App.tsx",
        status: "modified" as const,
        additions: 10,
        deletions: 2,
        changes: 12,
        isLarge: false,
        isGenerated: false,
        reviewStatus: "unreviewed" as const,
        annotations: 0,
        diagnostics: 0
      }
    ],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}

function anthropicSseStream(fullJson: string, chunkSize: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  for (let index = 0; index < fullJson.length; index += chunkSize) {
    const piece = fullJson.slice(index, index + chunkSize);
    lines.push(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: piece } })}\n`);
  }
  lines.push('data: {"type":"message_stop"}\n');

  let cursor = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor < lines.length) {
        controller.enqueue(encoder.encode(lines[cursor]));
        cursor += 1;
      } else {
        controller.close();
      }
    }
  });
}

function twoChapterTourJson(): string {
  return JSON.stringify({
    id: "provider-tour",
    generatedAt: "2026-05-22T00:00:00.000Z",
    chapters: [
      {
        id: "chapter-1",
        title: "Foundation",
        summary: "Introduce the primitive.",
        files: ["src/App.tsx"],
        diffAnchors: [{ path: "src/App.tsx", side: "right" }],
        changeStats: { additions: 10, deletions: 2, files: 1 },
        riskLevel: "low",
        riskReasons: [],
        reviewChecklist: ["Check the shell."],
        dependencies: [],
        generatedAt: "2026-05-22T00:00:00.000Z",
        model: "provider-model",
        headSha: pullRequest.headSha
      },
      {
        id: "chapter-2",
        title: "Consumer",
        summary: "Wire the primitive in.",
        files: ["src/main.tsx"],
        diffAnchors: [{ path: "src/main.tsx", side: "right" }],
        changeStats: { additions: 4, deletions: 0, files: 1 },
        riskLevel: "medium",
        riskReasons: [],
        reviewChecklist: ["Trace the call site."],
        dependencies: ["chapter-1"],
        generatedAt: "2026-05-22T00:00:00.000Z",
        model: "provider-model",
        headSha: pullRequest.headSha
      }
    ],
    graph: {
      nodes: [
        { id: "chapter-1", label: "Foundation", riskLevel: "low", files: ["src/App.tsx"] },
        { id: "chapter-2", label: "Consumer", riskLevel: "medium", files: ["src/main.tsx"] }
      ],
      edges: [{ id: "edge-1", from: "chapter-1", to: "chapter-2", relation: "dependency", confidence: 0.8, source: "ai" }]
    },
    riskSignals: []
  });
}

function providerTourJson(): string {
  return JSON.stringify({
    id: "provider-tour",
    generatedAt: "2026-05-22T00:00:00.000Z",
    chapters: [
      {
        id: "chapter-1",
        title: "Provider chapter",
        summary: "Review the app shell changes.",
        files: ["src/App.tsx"],
        diffAnchors: [{ path: "src/App.tsx", side: "right" }],
        changeStats: { additions: 10, deletions: 2, files: 1 },
        riskLevel: "low",
        riskReasons: [],
        reviewChecklist: ["Check the rendered shell."],
        dependencies: [],
        generatedAt: "2026-05-22T00:00:00.000Z",
        model: "provider-model",
        headSha: pullRequest.headSha
      }
    ],
    graph: {
      nodes: [{ id: "chapter-1", label: "Provider chapter", riskLevel: "low", files: ["src/App.tsx"] }],
      edges: []
    },
    riskSignals: []
  });
}
