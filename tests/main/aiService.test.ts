// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/main/services/database.js";
import { AiService } from "../../src/main/services/aiService.js";
import { Keychain } from "../../src/main/services/keychain.js";
import { DEFAULT_AI_MODELS } from "../../src/shared/aiModels.js";
import { defaultAppSettings, type AiProvider, type PullRequestDetail } from "../../src/shared/schemas.js";
import { AppError } from "../../src/main/errors.js";
import type { ReviewRepoAccess } from "../../src/main/services/ai/reviewTools.js";

const repository = { provider: "github" as const, owner: "kol", name: "repo", fullName: "kol/repo" };

const pullRequest: PullRequestDetail = {
  provider: "github",
  id: "1",
  number: 42,
  repository,
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

  it("reports an error when AI is disabled", async () => {
    const service = new AiService(openDatabase(":memory:"), new Keychain("test"), () => defaultAppSettings, stubRepos());

    await expect(service.generateTour(aiInput())).rejects.toMatchObject({ code: "ai_disabled" });
  });

  it("requires a managed worktree before running the agent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = makeService({ repos: { ...stubRepos(), getWorktreePath: () => null } });

    await expect(service.generateTour(aiInput())).rejects.toMatchObject({ code: "ai_requires_worktree" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disallows a model that cannot do tool calling instead of falling back", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = makeService({ provider: "ollama", model: "gemma:7b" });

    await expect(service.generateTour(aiInput())).rejects.toMatchObject({ code: "ai_tools_unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a provider 400 that rejects tools to ai_tools_unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "This model does not support tools." }) as unknown as Response)
    );
    const service = makeService();

    await expect(service.generateTour(aiInput())).rejects.toMatchObject({ code: "ai_tools_unsupported" });
  });

  it("reports an error when a configured provider request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    const service = makeService();

    await expect(service.generateTour(aiInput())).rejects.toMatchObject({ code: "ai_provider_error" });
  });

  it("honors an aborted generation signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = makeService();

    await expect(service.generateTour(aiInput(), { signal: controller.signal })).rejects.toBeInstanceOf(AppError);
  });

  it("runs the agent loop and assembles a tour from emitted tool calls", async () => {
    const fetchMock = queueFetch([
      anthropicTurn([toolUse("t1", "list_changed_files", {})]),
      anthropicTurn([
        toolUse("t2", "add_chapter", { id: "chapter-1", title: "Foundation", summary: "Introduce the primitive.", files: ["src/App.tsx"], riskLevel: "low" }),
        toolUse("t3", "add_chapter", { id: "chapter-2", title: "Consumer", summary: "Wire it in.", files: ["src/main.tsx"], riskLevel: "medium", dependencies: ["chapter-1"] }),
        toolUse("t4", "add_inline_comment", { chapterId: "chapter-1", path: "src/App.tsx", startLine: 1, comment: "new shell entry point" }),
        toolUse("t5", "add_edge", { from: "chapter-1", to: "chapter-2", relation: "dependency" }),
        toolUse("t6", "finish", {})
      ])
    ]);
    const service = makeService();

    const tour = await service.generateTour(aiInput());

    expect(tour.model).toBe(DEFAULT_AI_MODELS.anthropic);
    expect(tour.chapters.map((chapter) => chapter.title)).toEqual(["Foundation", "Consumer"]);
    expect(tour.graph.edges).toEqual([
      expect.objectContaining({ from: "chapter-1", to: "chapter-2", relation: "dependency", source: "ai" })
    ]);
    expect(tour.chapters[0]?.diffAnchors.find((anchor) => anchor.note === "new shell entry point")).toBeTruthy();

    const [endpoint, request] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    expect(String(endpoint)).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers).toMatchObject({ "x-api-key": "test-ai-key", "anthropic-version": "2023-06-01" });
    expect(JSON.parse(String(request?.body)).tools).toBeInstanceOf(Array);
  });

  it("reports a live chat feed of thinking, exploration, and tool calls", async () => {
    queueFetch([
      anthropicTurn([thinking("Let me look at what changed first."), toolUse("t1", "list_changed_files", {})]),
      anthropicTurn([
        toolUse("t2", "read_file", { path: "src/App.tsx" }),
        toolUse("t3", "add_chapter", { id: "chapter-1", title: "Foundation", summary: "x", files: ["src/App.tsx"], riskLevel: "low" }),
        toolUse("t4", "finish", {})
      ])
    ]);
    const service = makeService();

    const activity: Array<{ kind: string; text: string }> = [];
    await service.generateTour(aiInput(), {
      onProgress: (progress) => {
        if (progress.activity) {
          activity.push(progress.activity);
        }
      }
    });

    expect(activity).toContainEqual({ kind: "think", text: "Let me look at what changed first." });
    expect(activity).toContainEqual({ kind: "tool", text: "Reviewing the changed files" });
    expect(activity).toContainEqual({ kind: "tool", text: "Reading src/App.tsx" });
    expect(activity.some((entry) => entry.kind === "tool" && entry.text.includes("Foundation"))).toBe(true);
  });

  it("streams partial tours as chapters are emitted", async () => {
    queueFetch([
      anthropicTurn([
        toolUse("t1", "add_chapter", { id: "chapter-1", title: "Foundation", summary: "a", files: ["src/App.tsx"], riskLevel: "low" }),
        toolUse("t2", "add_chapter", { id: "chapter-2", title: "Consumer", summary: "b", files: ["src/main.tsx"], riskLevel: "low" }),
        toolUse("t3", "finish", {})
      ])
    ]);
    const service = makeService();

    const streamedChapterCounts: number[] = [];
    const tour = await service.generateTour(aiInput(), {
      onProgress: (progress) => {
        if (progress.tour) {
          streamedChapterCounts.push(progress.tour.chapters.length);
        }
      }
    });

    expect(tour.chapters).toHaveLength(2);
    expect(streamedChapterCounts).toContain(1);
    expect(Math.max(...streamedChapterCounts)).toBe(2);
    expect(streamedChapterCounts).toEqual([...streamedChapterCounts].sort((a, b) => a - b));
  });

  it("redacts file contents read by the agent before sending them to the provider", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const repos = stubRepos({ "src/App.tsx": `const token = "${secret}";\n` });
    const fetchMock = queueFetch([
      anthropicTurn([toolUse("t1", "read_file", { path: "src/App.tsx" })]),
      anthropicTurn([
        toolUse("t2", "add_chapter", { id: "chapter-1", title: "Shell", summary: "x", files: ["src/App.tsx"], riskLevel: "low" }),
        toolUse("t3", "finish", {})
      ])
    ]);
    const service = makeService({ repos });

    await service.generateTour(aiInput());

    // The second request carries the read_file tool result back to the model.
    const secondBody = String((fetchMock.mock.calls[1] as unknown as [unknown, RequestInit])[1]?.body);
    expect(secondBody).not.toContain(secret);
    expect(secondBody).toContain("REDACTED");
  });

  it("serves a cached tour and only re-runs when forced", async () => {
    const fetchMock = vi.fn(async () =>
      anthropicResponse([
        toolUse("t1", "add_chapter", { id: "chapter-1", title: "Only", summary: "x", files: ["src/App.tsx"], riskLevel: "low" }),
        toolUse("t2", "finish", {})
      ])
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = makeService();

    await service.generateTour(aiInput());
    const afterFirst = fetchMock.mock.calls.length;
    await service.generateTour(aiInput());
    expect(fetchMock.mock.calls.length).toBe(afterFirst); // cache hit, no new request

    await service.generateTour({ ...aiInput(), force: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("runs the same agent loop through a different provider (OpenAI)", async () => {
    const fetchMock = queueFetch([
      openAiTurn([{ id: "c1", function: { name: "add_chapter", arguments: JSON.stringify({ id: "chapter-1", title: "Only", summary: "x", files: ["src/App.tsx"], riskLevel: "low" }) } }, { id: "c2", function: { name: "finish", arguments: "{}" } }])
    ]);
    const service = makeService({ provider: "openai", model: "gpt-5-mini" });

    const tour = await service.generateTour(aiInput());

    expect(tour.model).toBe("gpt-5-mini");
    expect(tour.chapters).toHaveLength(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body));
    expect(body.tools).toBeInstanceOf(Array);
    expect(body.response_format).toBeUndefined(); // JSON mode must be dropped when tools are active
  });

  it("answers a question about the tour with the agent's final prose", async () => {
    queueFetch([anthropicText("The `StreamPermit` chapter introduces the backpressure primitive.")]);
    const service = makeService();

    const answer = await service.chatAboutTour(chatInput("What does the first chapter do?"));

    expect(answer).toBe("The `StreamPermit` chapter introduces the backpressure primitive.");
  });

  it("lets the chat agent explore with read-only tools before answering", async () => {
    const fetchMock = queueFetch([
      anthropicTurn([toolUse("t1", "read_file", { path: "src/App.tsx" })]),
      anthropicText("It reads `src/App.tsx` and wires the shell entry point.")
    ]);
    const service = makeService();

    const answer = await service.chatAboutTour(chatInput("How does it wire things in?"));

    expect(answer).toContain("wires the shell entry point");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The chat agent must not be offered the emit/finish tools.
    const toolNames = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body)).tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("add_chapter");
    expect(toolNames).not.toContain("finish");
  });

  it("includes the prior conversation when answering a follow-up", async () => {
    const fetchMock = queueFetch([anthropicText("Yes, the tests cover the new primitive.")]);
    const service = makeService();

    await service.chatAboutTour({
      ...chatInput("Are there tests?"),
      messages: [
        { role: "user", content: "What is the first chapter?" },
        { role: "assistant", content: "It is the StreamPermit primitive." },
        { role: "user", content: "Are there tests?" }
      ]
    });

    const body = String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1]?.body);
    expect(body).toContain("Conversation so far");
    expect(body).toContain("It is the StreamPermit primitive.");
    expect(body).toContain("Are there tests?");
  });

  it("rejects an empty chat answer as retryable", async () => {
    queueFetch([anthropicText("   ")]);
    const service = makeService();

    await expect(service.chatAboutTour(chatInput("anything?"))).rejects.toMatchObject({ code: "ai_empty_answer" });
  });

  it("requires a managed worktree to chat about the tour", async () => {
    const service = makeService({ repos: { ...stubRepos(), getWorktreePath: () => null } });

    await expect(service.chatAboutTour(chatInput("hi"))).rejects.toMatchObject({ code: "ai_requires_worktree" });
  });

  it("reports an error when AI is disabled for chat", async () => {
    const service = new AiService(openDatabase(":memory:"), new Keychain("test"), () => defaultAppSettings, stubRepos());

    await expect(service.chatAboutTour(chatInput("hi"))).rejects.toMatchObject({ code: "ai_disabled" });
  });
});

// --- helpers ----------------------------------------------------------------

function makeService(opts: { provider?: AiProvider; model?: string; repos?: ReviewRepoAccess; keychain?: Keychain } = {}): AiService {
  const provider = opts.provider ?? "anthropic";
  const model = opts.model ?? DEFAULT_AI_MODELS.anthropic;
  const keychain =
    opts.keychain ??
    (provider === "bedrock"
      ? ({ getSecret: vi.fn(async () => JSON.stringify({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret", region: "us-east-1" })) } as unknown as Keychain)
      : ({ getSecret: vi.fn(async () => "test-ai-key") } as unknown as Keychain));
  return new AiService(
    openDatabase(":memory:"),
    keychain,
    () => ({ ...defaultAppSettings, ai: { ...defaultAppSettings.ai, enabled: true, provider, model, thinkingEnabled: false } }),
    opts.repos ?? stubRepos()
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

function chatInput(question: string) {
  const base = aiInput();
  return {
    pullRequest,
    changedFiles: base.changedFiles,
    tour: sampleTour(),
    messages: [{ role: "user" as const, content: question }]
  };
}

function sampleTour() {
  const generatedAt = "2026-05-22T00:00:00.000Z";
  return {
    id: "tour-1",
    provider: "github" as const,
    repository,
    pullNumber: 42,
    headSha: "abcdef123",
    generatedAt,
    model: DEFAULT_AI_MODELS.anthropic,
    chapters: [
      {
        id: "chapter-1",
        title: "StreamPermit — the new backpressure primitive",
        summary: "Introduces the primitive.",
        files: ["src/App.tsx"],
        diffAnchors: [{ path: "src/App.tsx", side: "right" as const }],
        changeStats: { additions: 10, deletions: 2, files: 1 },
        riskLevel: "low" as const,
        riskReasons: [],
        reviewChecklist: [],
        dependencies: [],
        generatedAt,
        model: DEFAULT_AI_MODELS.anthropic,
        headSha: "abcdef123"
      }
    ],
    graph: {
      nodes: [{ id: "chapter-1", label: "StreamPermit", riskLevel: "low" as const, files: ["src/App.tsx"] }],
      edges: []
    },
    riskSignals: []
  };
}

function stubRepos(files: Record<string, string> = {}): ReviewRepoAccess {
  return {
    getWorktreePath: () => "/tmp/worktree",
    getLocalFileContent: async (_repository, path) => ({
      provider: "github",
      repository,
      path,
      ref: "abcdef123",
      contents: files[path] ?? "export const value = 1;\n",
      encoding: "utf-8",
      size: 20,
      isLarge: false
    }),
    getLocalFilePatch: async (_repository, _number, path) => ({
      provider: "github",
      repository,
      pullNumber: 42,
      path,
      patch: `@@ -1,1 +1,1 @@\n+// ${path}\n`,
      headSha: "abcdef123",
      isLarge: false
    }),
    searchWorkspaceText: async (_repository, _headSha, query) => ({
      repository,
      headSha: "abcdef123",
      query,
      searchedFiles: 1,
      skippedFiles: 0,
      truncated: false,
      results: [{ path: "src/main.tsx", matches: [{ lineNumber: 3, lineText: `calls ${query}` }] }]
    }),
    loadWorkspaceTree: async () => ({ repository, headSha: "abcdef123", worktreePath: "/tmp/worktree", paths: ["src/App.tsx", "src/main.tsx"] })
  };
}

function queueFetch(responses: Response[]) {
  const fn = vi.fn(async () => responses.shift() ?? responses[responses.length - 1]);
  vi.stubGlobal("fetch", fn);
  return fn;
}

interface AnthropicBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

function toolUse(id: string, name: string, input: unknown): AnthropicBlock {
  return { type: "tool_use", id, name, input };
}

function thinking(text: string): AnthropicBlock {
  return { type: "thinking", thinking: text };
}

function anthropicResponse(blocks: AnthropicBlock[]): Response {
  return {
    ok: true,
    json: async () => ({ content: blocks, stop_reason: "tool_use", usage: { output_tokens: 40 } })
  } as unknown as Response;
}

function anthropicTurn(blocks: AnthropicBlock[]): Response {
  return anthropicResponse(blocks);
}

// A turn with prose and no tool calls — the shape that ends an agent loop and,
// for chat, carries the answer.
function anthropicText(text: string): Response {
  return {
    ok: true,
    json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { output_tokens: 20 } })
  } as unknown as Response;
}

function openAiTurn(toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>): Response {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls.map((call) => ({ type: "function", ...call })) }, finish_reason: "tool_calls" }],
      usage: { completion_tokens: 40 }
    })
  } as unknown as Response;
}
