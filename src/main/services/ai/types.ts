import type { AiProvider, AppSettings } from "../../../shared/schemas.js";

// Provider-neutral conversation primitives shared by every ProviderAdapter.
//
// The agent runtime speaks in these terms; each adapter is responsible for
// translating them to and from its provider's native request/response shape.

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments object. */
  parameters: JsonSchema;
}

export interface ToolCall {
  /** Stable id used to correlate the result. Synthesized when a provider omits one. */
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface AssistantTurn {
  /** Any human-facing prose the model emitted alongside its tool calls. */
  text: string;
  /** The model's extended-thinking text, when the provider exposes it. */
  thinkingText?: string;
  toolCalls: ToolCall[];
  stopReason: "tool_use" | "end" | "length";
  /**
   * The provider-native assistant message (content blocks / parts / message
   * object) captured verbatim so the adapter can replay it on the next turn.
   * Required by Anthropic/Bedrock (thinking + tool_use blocks must round-trip)
   * and by OpenAI (the assistant tool_calls message precedes the tool results).
   */
  rawAssistant?: unknown;
  usage?: { outputTokens: number };
}

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; turn: AssistantTurn }
  | { role: "tool"; results: ToolResult[] };

export interface BuildRequestArgs {
  settings: AppSettings;
  system: string;
  messages: AgentMessage[];
  tools: ToolDef[];
  apiKey: string | null;
}

export interface ProviderAdapter {
  readonly provider: AiProvider;
  /** False only when the provider/transport structurally cannot do tool calling. */
  readonly supportsTools: boolean;
  /** Returns null when the provider is not fully configured (missing key/base url). */
  buildRequest(args: BuildRequestArgs): { url: string; init: RequestInit } | null;
  parseAssistantTurn(payload: unknown): AssistantTurn;
}
