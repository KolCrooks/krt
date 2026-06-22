import type { AiProvider } from "./schemas.js";

export interface ModelSuggestion {
  value: string;
  label: string;
}

export const DEFAULT_AI_MODELS = {
  disabled: "",
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  google: "gemini-3.5-flash",
  "azure-openai": "gpt-5.5",
  bedrock: "anthropic.claude-sonnet-4-6",
  ollama: "qwen3.6"
} as const satisfies Record<AiProvider, string>;

export const MODEL_SUGGESTIONS: Record<AiProvider, ModelSuggestion[]> = {
  disabled: [],
  anthropic: [
    { value: DEFAULT_AI_MODELS.anthropic, label: "Default, tool-capable, thinking-capable" },
    { value: "claude-opus-4-8", label: "Tool-capable, adaptive thinking" },
    { value: "claude-fable-5", label: "Tool-capable, latest generation" },
    { value: "claude-haiku-4-5-20251001", label: "Tool-capable, low latency" }
  ],
  openai: [
    { value: DEFAULT_AI_MODELS.openai, label: "Default, tool-capable" },
    { value: "gpt-5.4-mini", label: "Tool-capable, lower latency" },
    { value: "gpt-5.4", label: "Tool-capable" },
    { value: "gpt-5.4-nano", label: "Tool-capable, lowest cost" }
  ],
  google: [
    { value: DEFAULT_AI_MODELS.google, label: "Default, tool-capable" },
    { value: "gemini-3.1-pro-preview", label: "Tool-capable, agentic preview" },
    { value: "gemini-3-flash-preview", label: "Tool-capable, preview" },
    { value: "gemini-2.5-flash", label: "Tool-capable" }
  ],
  "azure-openai": [
    { value: DEFAULT_AI_MODELS["azure-openai"], label: "Use your Azure deployment name" },
    { value: "gpt-5.4-mini", label: "Use your Azure deployment name" },
    { value: "gpt-5.4", label: "Use your Azure deployment name" },
    { value: "gpt-5.3-codex", label: "Use your Azure deployment name" },
    { value: "gpt-chat-latest", label: "Use your Azure deployment name" }
  ],
  bedrock: [
    { value: DEFAULT_AI_MODELS.bedrock, label: "Default, tool-capable, thinking-capable" },
    { value: "anthropic.claude-opus-4-8", label: "Tool-capable, adaptive thinking" },
    { value: "anthropic.claude-haiku-4-5-20251001-v1:0", label: "Tool-capable, low latency" }
  ],
  ollama: [
    { value: DEFAULT_AI_MODELS.ollama, label: "Requires tool support in local runtime" },
    { value: "qwen3.5", label: "Requires tool support in local runtime" },
    { value: "llama4", label: "Requires tool support in local runtime" },
    { value: "devstral", label: "Requires tool support in local runtime" }
  ]
};

export const STALE_DEFAULT_AI_MODELS: Partial<Record<AiProvider, string[]>> = {
  anthropic: ["claude-sonnet-4-5"],
  openai: ["gpt-5-mini"],
  google: ["gemini-2.5-flash"],
  "azure-openai": ["gpt-5-mini"],
  bedrock: ["anthropic.claude-3-5-sonnet-20241022-v2:0"],
  ollama: ["llama3.1"]
};
