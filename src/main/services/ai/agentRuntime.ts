import type { AppSettings } from "../../../shared/schemas.js";
import { AppError } from "../../errors.js";
import type { AgentMessage, ProviderAdapter, ToolResult } from "./types.js";
import { describeToolCall, type ReviewToolset } from "./reviewTools.js";

export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_TOKEN_BUDGET = 200_000;

export interface RunReviewAgentArgs {
  adapter: ProviderAdapter;
  settings: AppSettings;
  apiKey: string | null;
  system: string;
  userMessage: string;
  toolset: ReviewToolset;
  signal?: AbortSignal;
  /** Fires for each step the agent takes — its thinking, narration, every tool
   *  call, and tool errors — so the UI can show a live chat feed of the work. */
  onActivity?: (info: { turn: number; kind: "think" | "say" | "tool" | "result"; text: string }) => void;
  maxTurns?: number;
  tokenBudget?: number;
}

export interface AgentRunResult {
  turns: number;
  outputTokens: number;
  finished: boolean;
  stoppedReason: "finished" | "no_tool_calls" | "max_turns" | "token_budget";
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError("operation_cancelled", "AI tour generation was cancelled.", { retryable: true });
  }
}

export async function runReviewAgent(args: RunReviewAgentArgs): Promise<AgentRunResult> {
  const { adapter, settings, apiKey, system, userMessage, toolset, signal } = args;
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_TURNS;
  const tokenBudget = args.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const messages: AgentMessage[] = [{ role: "user", content: userMessage }];
  let outputTokens = 0;
  let stoppedReason: AgentRunResult["stoppedReason"] = "max_turns";
  let turn = 0;

  for (turn = 1; turn <= maxTurns; turn += 1) {
    assertNotAborted(signal);
    const request = adapter.buildRequest({ settings, system, messages, tools: toolset.tools, apiKey });
    if (!request) {
      throw new AppError("ai_not_configured", `The ${adapter.provider} provider is not fully configured.`);
    }

    let response: Response;
    try {
      response = await fetch(request.url, { ...request.init, signal });
    } catch (error) {
      assertNotAborted(signal);
      throw new AppError(
        "ai_request_failed",
        `The ${adapter.provider} request could not be completed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true }
      );
    }

    if (!response.ok) {
      throw await mapHttpError(adapter.provider, response);
    }

    assertNotAborted(signal);
    const payload = (await response.json()) as unknown;
    const assistantTurn = adapter.parseAssistantTurn(payload);
    outputTokens += assistantTurn.usage?.outputTokens ?? 0;
    messages.push({ role: "assistant", turn: assistantTurn });
    if (assistantTurn.thinkingText?.trim()) {
      args.onActivity?.({ turn, kind: "think", text: assistantTurn.thinkingText.trim() });
    }
    if (assistantTurn.text.trim()) {
      args.onActivity?.({ turn, kind: "say", text: assistantTurn.text.trim() });
    }

    if (assistantTurn.toolCalls.length === 0) {
      stoppedReason = "no_tool_calls";
      break;
    }

    const results: ToolResult[] = [];
    for (const call of assistantTurn.toolCalls) {
      assertNotAborted(signal);
      args.onActivity?.({ turn, kind: "tool", text: describeToolCall(call) });
      const outcome = await toolset.execute(call);
      if (outcome.isError) {
        args.onActivity?.({ turn, kind: "result", text: outcome.content });
      }
      results.push({ toolCallId: call.id, name: call.name, content: outcome.content, isError: outcome.isError });
    }
    messages.push({ role: "tool", results });

    if (toolset.finishRequested) {
      stoppedReason = "finished";
      break;
    }
    if (outputTokens >= tokenBudget) {
      stoppedReason = "token_budget";
      break;
    }
  }

  return { turns: Math.min(turn, maxTurns), outputTokens, finished: toolset.finishRequested, stoppedReason };
}

async function mapHttpError(provider: string, response: Response): Promise<AppError> {
  const retryable = response.status >= 500 || response.status === 429;
  if (response.status === 400 || response.status === 422) {
    const body = await safeReadText(response);
    if (looksLikeToolUnsupported(body)) {
      return new AppError(
        "ai_tools_unsupported",
        `The configured ${provider} model does not support tool calling, which AI review requires. Choose a tool-capable model in Settings → AI Review.`,
        { retryable: false }
      );
    }
  }
  return new AppError("ai_provider_error", `The ${provider} request failed with status ${response.status}.`, { retryable });
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function looksLikeToolUnsupported(body: string): boolean {
  const text = body.toLowerCase();
  const mentionsTools = text.includes("tool") || text.includes("function call") || text.includes("function_call") || text.includes("functioncall");
  const mentionsUnsupported = text.includes("not support") || text.includes("unsupported") || text.includes("does not support") || text.includes("not available") || text.includes("cannot use");
  return mentionsTools && mentionsUnsupported;
}
