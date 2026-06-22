import { DEFAULT_AI_MODELS } from "../../../shared/aiModels.js";
import type { AiProvider, AppSettings } from "../../../shared/schemas.js";
import type { AssistantTurn, BuildRequestArgs, ProviderAdapter, ToolCall, ToolDef } from "./types.js";
import {
  ANTHROPIC_VERSION,
  appendEndpoint,
  buildAzureOpenAiEndpoint,
  inferBedrockRegion,
  joinTextParts,
  modelSupportsThinking,
  parseBedrockCredentials,
  parseToolArguments,
  signAwsJsonRequest,
  thinkingBudgetFor
} from "./providerHttp.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;

function stopReasonFor(native: string | undefined, toolUse: boolean): AssistantTurn["stopReason"] {
  if (toolUse) {
    return "tool_use";
  }
  if (native === "length" || native === "max_tokens" || native === "MAX_TOKENS") {
    return "length";
  }
  return "end";
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

const anthropicAdapter: ProviderAdapter = {
  provider: "anthropic",
  supportsTools: true,
  buildRequest({ settings, system, messages, tools, apiKey }: BuildRequestArgs) {
    if (!apiKey) {
      return null;
    }
    const model = settings.ai.model || DEFAULT_AI_MODELS.anthropic;
    const thinking = settings.ai.thinkingEnabled && modelSupportsThinking(model);
    const nativeMessages = messages.map((message) => {
      if (message.role === "user") {
        return { role: "user", content: message.content };
      }
      if (message.role === "assistant") {
        return { role: "assistant", content: message.turn.rawAssistant };
      }
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {})
        }))
      };
    });

    return {
      url: appendEndpoint(settings.ai.baseUrl ?? "https://api.anthropic.com", "/v1/messages"),
      init: {
        method: "POST",
        headers: { ...JSON_HEADERS, "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({
          model,
          max_tokens: settings.ai.maxOutputTokens,
          ...(thinking ? { thinking: { type: "enabled", budget_tokens: thinkingBudgetFor(settings) } } : {}),
          system,
          tools: tools.map(toAnthropicTool),
          messages: nativeMessages
        })
      }
    };
  },
  parseAssistantTurn(payload: unknown): AssistantTurn {
    const value = payload as {
      content?: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string;
      usage?: { output_tokens?: number };
    };
    const blocks = value.content ?? [];
    const toolCalls: ToolCall[] = blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: block.input ?? {} }));
    const thinkingText = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("")
      .trim();
    return {
      text: joinTextParts(blocks.filter((block) => block.type === "text")),
      thinkingText: thinkingText || undefined,
      toolCalls,
      stopReason: stopReasonFor(value.stop_reason, toolCalls.length > 0),
      rawAssistant: blocks,
      usage: { outputTokens: value.usage?.output_tokens ?? 0 }
    };
  }
};

function toAnthropicTool(tool: ToolDef): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

// ---------------------------------------------------------------------------
// OpenAI / Azure OpenAI Chat Completions (shared shape)
// ---------------------------------------------------------------------------

function openAiNativeMessages(system: string, messages: BuildRequestArgs["messages"]): unknown[] {
  const native: unknown[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      native.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      native.push(message.turn.rawAssistant);
    } else {
      for (const result of message.results) {
        native.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
      }
    }
  }
  return native;
}

function toOpenAiTool(tool: ToolDef): Record<string, unknown> {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function parseOpenAiTurn(payload: unknown): AssistantTurn {
  const value = payload as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
      finish_reason?: string;
    }>;
    usage?: { completion_tokens?: number };
  };
  const choice = value.choices?.[0];
  const message = choice?.message ?? {};
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
    id: String(call.id ?? `tool-${index}`),
    name: String(call.function?.name ?? ""),
    arguments: parseToolArguments(call.function?.arguments)
  }));
  return {
    text: message.content ?? "",
    toolCalls,
    stopReason: stopReasonFor(choice?.finish_reason, toolCalls.length > 0),
    rawAssistant: message,
    usage: { outputTokens: value.usage?.completion_tokens ?? 0 }
  };
}

const openAiAdapter: ProviderAdapter = {
  provider: "openai",
  supportsTools: true,
  buildRequest({ settings, system, messages, tools, apiKey }: BuildRequestArgs) {
    if (!apiKey) {
      return null;
    }
    return {
      url: appendEndpoint(settings.ai.baseUrl ?? "https://api.openai.com/v1", "/chat/completions"),
      init: {
        method: "POST",
        headers: { ...JSON_HEADERS, authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: settings.ai.model || DEFAULT_AI_MODELS.openai,
          messages: openAiNativeMessages(system, messages),
          tools: tools.map(toOpenAiTool),
          tool_choice: "auto",
          max_completion_tokens: settings.ai.maxOutputTokens
        })
      }
    };
  },
  parseAssistantTurn: parseOpenAiTurn
};

const azureOpenAiAdapter: ProviderAdapter = {
  provider: "azure-openai",
  supportsTools: true,
  buildRequest({ settings, system, messages, tools, apiKey }: BuildRequestArgs) {
    if (!apiKey || !settings.ai.baseUrl) {
      return null;
    }
    return {
      url: buildAzureOpenAiEndpoint(settings.ai.baseUrl, settings.ai.model || "default"),
      init: {
        method: "POST",
        headers: { ...JSON_HEADERS, "api-key": apiKey },
        body: JSON.stringify({
          messages: openAiNativeMessages(system, messages),
          tools: tools.map(toOpenAiTool),
          tool_choice: "auto",
          max_completion_tokens: settings.ai.maxOutputTokens
        })
      }
    };
  },
  parseAssistantTurn: parseOpenAiTurn
};

// ---------------------------------------------------------------------------
// Google Gemini generateContent
// ---------------------------------------------------------------------------

const googleAdapter: ProviderAdapter = {
  provider: "google",
  supportsTools: true,
  buildRequest({ settings, system, messages, tools, apiKey }: BuildRequestArgs) {
    if (!apiKey) {
      return null;
    }
    const model = encodeURIComponent(settings.ai.model || DEFAULT_AI_MODELS.google);
    const endpoint = new URL(
      appendEndpoint(settings.ai.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta", `/models/${model}:generateContent`)
    );
    endpoint.searchParams.set("key", apiKey);

    const contents = messages.map((message) => {
      if (message.role === "user") {
        return { role: "user", parts: [{ text: message.content }] };
      }
      if (message.role === "assistant") {
        return { role: "model", parts: message.turn.rawAssistant };
      }
      return {
        role: "user",
        parts: message.results.map((result) => ({
          functionResponse: {
            name: result.name,
            response: result.isError ? { error: result.content } : { result: result.content }
          }
        }))
      };
    });

    return {
      url: endpoint.toString(),
      init: {
        method: "POST",
        headers: { ...JSON_HEADERS },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }],
          contents,
          generationConfig: { temperature: 0.2, maxOutputTokens: settings.ai.maxOutputTokens }
        })
      }
    };
  },
  parseAssistantTurn(payload: unknown): AssistantTurn {
    const value = payload as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> }; finishReason?: string }>;
      usageMetadata?: { candidatesTokenCount?: number };
    };
    const candidate = value.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolCalls: ToolCall[] = parts
      .filter((part) => part.functionCall)
      .map((part, index) => ({
        id: `${part.functionCall?.name ?? "tool"}-${index}`,
        name: String(part.functionCall?.name ?? ""),
        arguments: part.functionCall?.args ?? {}
      }));
    return {
      text: joinTextParts(parts.filter((part) => typeof part.text === "string")),
      toolCalls,
      stopReason: stopReasonFor(candidate?.finishReason, toolCalls.length > 0),
      rawAssistant: parts,
      usage: { outputTokens: value.usageMetadata?.candidatesTokenCount ?? 0 }
    };
  }
};

// ---------------------------------------------------------------------------
// Ollama /api/chat
// ---------------------------------------------------------------------------

const ollamaAdapter: ProviderAdapter = {
  provider: "ollama",
  supportsTools: true,
  buildRequest({ settings, system, messages, tools }: BuildRequestArgs) {
    const native: unknown[] = [{ role: "system", content: system }];
    for (const message of messages) {
      if (message.role === "user") {
        native.push({ role: "user", content: message.content });
      } else if (message.role === "assistant") {
        native.push(message.turn.rawAssistant);
      } else {
        for (const result of message.results) {
          // Ollama follows the OpenAI chat schema; include the call id and name
          // so the model can correlate each result to its tool call.
          native.push({ role: "tool", tool_call_id: result.toolCallId, tool_name: result.name, content: result.content });
        }
      }
    }
    return {
      url: appendEndpoint(settings.ai.baseUrl ?? "http://127.0.0.1:11434", "/api/chat"),
      init: {
        method: "POST",
        headers: { ...JSON_HEADERS },
        body: JSON.stringify({
          model: settings.ai.model || DEFAULT_AI_MODELS.ollama,
          messages: native,
          tools: tools.map(toOpenAiTool),
          stream: false,
          options: { num_predict: settings.ai.maxOutputTokens }
        })
      }
    };
  },
  parseAssistantTurn(payload: unknown): AssistantTurn {
    const value = payload as {
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
      done_reason?: string;
      eval_count?: number;
    };
    const message = value.message ?? {};
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call, index) => ({
      id: `tool-${index}`,
      name: String(call.function?.name ?? ""),
      arguments: parseToolArguments(call.function?.arguments)
    }));
    return {
      text: message.content ?? "",
      toolCalls,
      stopReason: stopReasonFor(value.done_reason, toolCalls.length > 0),
      rawAssistant: message,
      usage: { outputTokens: value.eval_count ?? 0 }
    };
  }
};

// ---------------------------------------------------------------------------
// Amazon Bedrock Converse
// ---------------------------------------------------------------------------

const bedrockAdapter: ProviderAdapter = {
  provider: "bedrock",
  supportsTools: true,
  buildRequest({ settings, system, messages, tools, apiKey }: BuildRequestArgs) {
    const credentials = parseBedrockCredentials(apiKey);
    if (!credentials) {
      return null;
    }
    const region = credentials.region ?? inferBedrockRegion(settings.ai.baseUrl) ?? "us-east-1";
    const baseUrl = settings.ai.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`;
    const modelId = settings.ai.model || DEFAULT_AI_MODELS.bedrock;
    const endpoint = new URL(`${baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(modelId)}/converse`);
    const thinking = settings.ai.thinkingEnabled && modelSupportsThinking(modelId);

    const nativeMessages = messages.map((message) => {
      if (message.role === "user") {
        return { role: "user", content: [{ text: message.content }] };
      }
      if (message.role === "assistant") {
        return { role: "assistant", content: message.turn.rawAssistant };
      }
      return {
        role: "user",
        content: message.results.map((result) => ({
          toolResult: {
            toolUseId: result.toolCallId,
            content: [{ text: result.content }],
            ...(result.isError ? { status: "error" } : {})
          }
        }))
      };
    });

    const body = JSON.stringify({
      system: [{ text: system }],
      messages: nativeMessages,
      toolConfig: {
        tools: tools.map((tool) => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters } } }))
      },
      inferenceConfig: {
        maxTokens: settings.ai.maxOutputTokens,
        ...(thinking ? {} : { temperature: 0.2 })
      },
      ...(thinking
        ? { additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: thinkingBudgetFor(settings) } } }
        : {})
    });
    const headers = signAwsJsonRequest({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region,
      service: "bedrock",
      method: "POST",
      url: endpoint,
      body
    });

    return { url: endpoint.toString(), init: { method: "POST", headers, body } };
  },
  parseAssistantTurn(payload: unknown): AssistantTurn {
    const value = payload as {
      output?: {
        message?: {
          content?: Array<{
            text?: string;
            reasoningContent?: { reasoningText?: { text?: string } };
            toolUse?: { toolUseId?: string; name?: string; input?: unknown };
          }>;
        };
      };
      stopReason?: string;
      usage?: { outputTokens?: number };
    };
    const content = value.output?.message?.content ?? [];
    const toolCalls: ToolCall[] = content
      .filter((block) => block.toolUse)
      .map((block) => ({
        id: String(block.toolUse?.toolUseId ?? ""),
        name: String(block.toolUse?.name ?? ""),
        arguments: block.toolUse?.input ?? {}
      }));
    const thinkingText = content
      .map((block) => block.reasoningContent?.reasoningText?.text ?? "")
      .join("")
      .trim();
    return {
      text: joinTextParts(content.filter((block) => typeof block.text === "string")),
      thinkingText: thinkingText || undefined,
      toolCalls,
      stopReason: stopReasonFor(value.stopReason, toolCalls.length > 0),
      rawAssistant: content,
      usage: { outputTokens: value.usage?.outputTokens ?? 0 }
    };
  }
};

const ADAPTERS: Partial<Record<AiProvider, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openAiAdapter,
  "azure-openai": azureOpenAiAdapter,
  google: googleAdapter,
  ollama: ollamaAdapter,
  bedrock: bedrockAdapter
};

export function getProviderAdapter(provider: AiProvider): ProviderAdapter | null {
  return ADAPTERS[provider] ?? null;
}

// Models that cannot do tool calling and therefore cannot run the review agent.
// Matched as a lowercased substring of the configured model id.
const NON_TOOL_MODEL_PATTERNS = [
  "instruct", // generic instruct-tuned local models rarely support tool calling
  "gpt-3.5-turbo-instruct",
  "text-davinci",
  "gemma", // Gemma (incl. via Ollama) has no function-calling
  "phi-2",
  "tinyllama",
  "orca-mini"
];

export function modelLikelyLacksToolSupport(provider: AiProvider, model: string): boolean {
  const normalized = model.toLowerCase();
  if (!normalized) {
    return false;
  }
  return NON_TOOL_MODEL_PATTERNS.some((pattern) => normalized.includes(pattern));
}
