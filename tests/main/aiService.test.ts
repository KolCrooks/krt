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

  it("generates and caches a deterministic tour when AI is disabled", async () => {
    const db = openDatabase(":memory:");
    const service = new AiService(db, new Keychain("test"), () => defaultAppSettings);

    const tour = await service.generateTour({
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
    });

    expect(tour.chapters).toHaveLength(1);
    expect(service.getCachedTour(pullRequest.repository, pullRequest.number, pullRequest.headSha)?.id).toBe(tour.id);
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

    await service.generateTour({
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
          severity: "info"
        }
      ],
      reviewThreads: [],
      checks: []
    });

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

    await service.generateTour({
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
    });

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
