// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getProviderAdapter, modelLikelyLacksToolSupport } from "../../../src/main/services/ai/adapters.js";
import type { AgentMessage, ProviderAdapter, ToolDef } from "../../../src/main/services/ai/types.js";
import { defaultAppSettings, type AiProvider, type AppSettings } from "../../../src/shared/schemas.js";

const TOOL: ToolDef = {
  name: "read_file",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
};

function settingsFor(provider: AiProvider, overrides: Partial<AppSettings["ai"]> = {}): AppSettings {
  return {
    ...defaultAppSettings,
    ai: { ...defaultAppSettings.ai, enabled: true, provider, model: "test-model", thinkingEnabled: false, ...overrides }
  };
}

// A conversation that exercises every message kind the adapter must serialize:
// initial user prompt, a replayed assistant turn that called a tool, and the
// tool result fed back in.
function conversation(adapter: ProviderAdapter, payload: unknown): AgentMessage[] {
  const turn = adapter.parseAssistantTurn(payload);
  return [
    { role: "user", content: "Build the tour." },
    { role: "assistant", turn },
    { role: "tool", results: [{ toolCallId: turn.toolCalls[0]?.id ?? "x", name: "read_file", content: "file body" }] }
  ];
}

describe("provider adapters", () => {
  it("flags models that cannot do tool calling", () => {
    expect(modelLikelyLacksToolSupport("ollama", "gemma:7b")).toBe(true);
    expect(modelLikelyLacksToolSupport("openai", "gpt-3.5-turbo-instruct")).toBe(true);
    expect(modelLikelyLacksToolSupport("anthropic", "claude-sonnet-4-5")).toBe(false);
    expect(modelLikelyLacksToolSupport("openai", "gpt-5-mini")).toBe(false);
  });

  it("Anthropic: parses tool_use and replays tool_result", () => {
    const adapter = getProviderAdapter("anthropic")!;
    const payload = {
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", id: "tu1", name: "read_file", input: { path: "a.ts" } }
      ],
      stop_reason: "tool_use",
      usage: { output_tokens: 7 }
    };
    const turn = adapter.parseAssistantTurn(payload);
    expect(turn.text).toBe("looking");
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.toolCalls).toEqual([{ id: "tu1", name: "read_file", arguments: { path: "a.ts" } }]);
    expect(turn.usage?.outputTokens).toBe(7);

    const request = adapter.buildRequest({ settings: settingsFor("anthropic"), system: "SYS", messages: conversation(adapter, payload), tools: [TOOL], apiKey: "k" })!;
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.system).toBe("SYS");
    expect(body.tools[0]).toMatchObject({ name: "read_file", input_schema: TOOL.parameters });
    const last = body.messages.at(-1);
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1", content: "file body" });
  });

  it("OpenAI: parses tool_calls, drops JSON mode, replays tool message", () => {
    const adapter = getProviderAdapter("openai")!;
    const payload = {
      choices: [{ message: { role: "assistant", content: "ok", tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] }, finish_reason: "tool_calls" }],
      usage: { completion_tokens: 9 }
    };
    const turn = adapter.parseAssistantTurn(payload);
    expect(turn.toolCalls).toEqual([{ id: "tc1", name: "read_file", arguments: { path: "a.ts" } }]);
    expect(turn.stopReason).toBe("tool_use");

    const request = adapter.buildRequest({ settings: settingsFor("openai"), system: "SYS", messages: conversation(adapter, payload), tools: [TOOL], apiKey: "k" })!;
    const body = JSON.parse(String(request.init.body));
    expect(body.response_format).toBeUndefined();
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "read_file" } });
    expect(body.messages[0]).toMatchObject({ role: "system", content: "SYS" });
    expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "tc1", content: "file body" });
  });

  it("Azure OpenAI: requires a base url and signs with api-key", () => {
    const adapter = getProviderAdapter("azure-openai")!;
    const payload = { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "tc1", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };
    expect(adapter.buildRequest({ settings: settingsFor("azure-openai"), system: "S", messages: [], tools: [TOOL], apiKey: "k" })).toBeNull();

    const request = adapter.buildRequest({
      settings: settingsFor("azure-openai", { baseUrl: "https://krt.openai.azure.com", model: "review-deploy" }),
      system: "S",
      messages: conversation(adapter, payload),
      tools: [TOOL],
      apiKey: "k"
    })!;
    expect(request.url).toContain("/openai/deployments/review-deploy/chat/completions?api-version=");
    expect((request.init.headers as Record<string, string>)["api-key"]).toBe("k");
  });

  it("Google: parses functionCall and replays functionResponse", () => {
    const adapter = getProviderAdapter("google")!;
    const payload = {
      candidates: [{ content: { parts: [{ text: "hi" }, { functionCall: { name: "read_file", args: { path: "a.ts" } } }] }, finishReason: "STOP" }],
      usageMetadata: { candidatesTokenCount: 4 }
    };
    const turn = adapter.parseAssistantTurn(payload);
    expect(turn.toolCalls[0]).toMatchObject({ name: "read_file", arguments: { path: "a.ts" } });
    expect(turn.stopReason).toBe("tool_use");

    const request = adapter.buildRequest({ settings: settingsFor("google"), system: "SYS", messages: conversation(adapter, payload), tools: [TOOL], apiKey: "k" })!;
    expect(request.url).toContain(":generateContent");
    expect(request.url).toContain("key=k");
    const body = JSON.parse(String(request.init.body));
    expect(body.systemInstruction.parts[0].text).toBe("SYS");
    expect(body.tools[0].functionDeclarations[0]).toMatchObject({ name: "read_file" });
    expect(body.contents.at(-1).parts[0].functionResponse.name).toBe("read_file");
  });

  it("Ollama: parses object tool args and replays tool role", () => {
    const adapter = getProviderAdapter("ollama")!;
    const payload = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }] }, done_reason: "stop", eval_count: 3 };
    const turn = adapter.parseAssistantTurn(payload);
    expect(turn.toolCalls[0]).toMatchObject({ name: "read_file", arguments: { path: "a.ts" } });
    expect(turn.stopReason).toBe("tool_use");

    const request = adapter.buildRequest({ settings: settingsFor("ollama"), system: "SYS", messages: conversation(adapter, payload), tools: [TOOL], apiKey: null })!;
    const body = JSON.parse(String(request.init.body));
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "read_file" } });
    expect(body.messages[0]).toMatchObject({ role: "system" });
    expect(body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "tool-0", content: "file body" });
  });

  it("Bedrock: parses toolUse, signs the request, replays toolResult", () => {
    const adapter = getProviderAdapter("bedrock")!;
    const payload = {
      output: { message: { content: [{ text: "hi" }, { toolUse: { toolUseId: "tu1", name: "read_file", input: { path: "a.ts" } } }] } },
      stopReason: "tool_use",
      usage: { outputTokens: 6 }
    };
    const turn = adapter.parseAssistantTurn(payload);
    expect(turn.toolCalls[0]).toMatchObject({ id: "tu1", name: "read_file", arguments: { path: "a.ts" } });

    const creds = JSON.stringify({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "secret", region: "us-east-1" });
    const request = adapter.buildRequest({ settings: settingsFor("bedrock"), system: "SYS", messages: conversation(adapter, payload), tools: [TOOL], apiKey: creds })!;
    const body = JSON.parse(String(request.init.body));
    expect(body.toolConfig.tools[0].toolSpec).toMatchObject({ name: "read_file" });
    expect(body.messages.at(-1).content[0].toolResult).toMatchObject({ toolUseId: "tu1" });
    expect((request.init.headers as Record<string, string>).authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
  });

  it("returns null when a key-backed provider has no api key", () => {
    expect(getProviderAdapter("anthropic")!.buildRequest({ settings: settingsFor("anthropic"), system: "", messages: [], tools: [TOOL], apiKey: null })).toBeNull();
    expect(getProviderAdapter("openai")!.buildRequest({ settings: settingsFor("openai"), system: "", messages: [], tools: [TOOL], apiKey: null })).toBeNull();
  });
});
