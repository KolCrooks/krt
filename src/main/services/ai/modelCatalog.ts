import type { AiProvider, AppSettings } from "../../../shared/schemas.js";
import { AppError } from "../../errors.js";
import { modelLikelyLacksToolSupport } from "./adapters.js";
import {
  ANTHROPIC_VERSION,
  AZURE_OPENAI_API_VERSION,
  appendEndpoint,
  inferBedrockRegion,
  parseBedrockCredentials,
  signAwsJsonRequest
} from "./providerHttp.js";

// Discovery turns the model field in Settings → AI Review from a hardcoded
// suggestion list into a live list of the models the configured credentials can
// actually reach. Each provider exposes a "list models" endpoint; we query it,
// normalize the result to DiscoveredModel, and annotate tool-calling support so
// the UI can steer the reviewer toward models that can run the agent.

export interface DiscoveredModel {
  /** The id to write into settings.ai.model. */
  id: string;
  /** Human-friendly name / family, shown beside the id when the provider gives one. */
  label?: string;
  /** Whether the model can do tool calling, which AI review requires. */
  toolCapable: boolean;
}

export interface DiscoverModelsArgs {
  provider: AiProvider;
  settings: AppSettings;
  apiKey: string | null;
  signal?: AbortSignal;
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_MODELS = 200;

export async function discoverModels(args: DiscoverModelsArgs): Promise<DiscoveredModel[]> {
  switch (args.provider) {
    case "anthropic":
      return listAnthropic(args);
    case "openai":
      return listOpenAi(args);
    case "azure-openai":
      return listAzureOpenAi(args);
    case "google":
      return listGoogle(args);
    case "ollama":
      return listOllama(args);
    case "bedrock":
      return listBedrock(args);
    case "disabled":
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Anthropic — GET /v1/models
// ---------------------------------------------------------------------------

async function listAnthropic({ settings, apiKey, signal }: DiscoverModelsArgs): Promise<DiscoveredModel[]> {
  const key = requireKey("anthropic", apiKey);
  const url = new URL(appendEndpoint(settings.ai.baseUrl ?? "https://api.anthropic.com", "/v1/models"));
  url.searchParams.set("limit", "1000");
  const payload = (await fetchModelsJson(
    "anthropic",
    url.toString(),
    { method: "GET", headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION } },
    signal
  )) as { data?: Array<{ id?: string; display_name?: string }> };
  return finalize((payload.data ?? []).map((model) => toModel("anthropic", model.id, model.display_name)));
}

// ---------------------------------------------------------------------------
// OpenAI (and OpenAI-compatible servers) — GET /models
// ---------------------------------------------------------------------------

// Drop the non-conversational model families OpenAI returns alongside chat
// models (embeddings, audio, image, moderation). Everything else — including
// custom ids from OpenAI-compatible servers — is kept and annotated by tool
// support so the list stays useful beyond the official catalog.
const OPENAI_NON_CHAT = /embedding|whisper|tts|audio|realtime|image|dall[-_.]?e|moderation|transcrib|sora/;

async function listOpenAi({ settings, apiKey, signal }: DiscoverModelsArgs): Promise<DiscoveredModel[]> {
  const key = requireKey("openai", apiKey);
  const payload = (await fetchModelsJson(
    "openai",
    appendEndpoint(settings.ai.baseUrl ?? "https://api.openai.com/v1", "/models"),
    { method: "GET", headers: { authorization: `Bearer ${key}` } },
    signal
  )) as { data?: Array<{ id?: string }> };
  const ids = (payload.data ?? [])
    .map((model) => String(model.id ?? ""))
    .filter((id) => id && !OPENAI_NON_CHAT.test(id.toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
  return finalize(ids.map((id) => toModel("openai", id)));
}

// ---------------------------------------------------------------------------
// Azure OpenAI — GET {resource}/openai/deployments
// ---------------------------------------------------------------------------

async function listAzureOpenAi({ settings, apiKey, signal }: DiscoverModelsArgs): Promise<DiscoveredModel[]> {
  const key = requireKey("azure-openai", apiKey);
  const baseUrl = settings.ai.baseUrl?.trim();
  if (!baseUrl) {
    throw new AppError(
      "ai_models_no_base_url",
      "Set the Azure OpenAI base URL (e.g. https://my-resource.openai.azure.com) to list deployments."
    );
  }
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/openai/deployments`);
  url.searchParams.set("api-version", AZURE_OPENAI_API_VERSION);

  let payload: { data?: Array<{ id?: string; model?: string }> };
  try {
    payload = (await fetchModelsJson(
      "azure-openai",
      url.toString(),
      { method: "GET", headers: { "api-key": key } },
      signal
    )) as { data?: Array<{ id?: string; model?: string }> };
  } catch (error) {
    // Listing deployments over the data plane isn't available on every API
    // version or resource. A reachable-but-unsupported listing falls back to
    // manual entry rather than surfacing an error; auth failures still throw.
    if (error instanceof AppError && error.code === "ai_models_failed") {
      return [];
    }
    throw error;
  }

  return finalize(
    (payload.data ?? []).map((deployment) =>
      toModel("azure-openai", deployment.id, deployment.model ? `deployment of ${deployment.model}` : undefined)
    )
  );
}

// ---------------------------------------------------------------------------
// Google Gemini — GET /models
// ---------------------------------------------------------------------------

async function listGoogle({ settings, apiKey, signal }: DiscoverModelsArgs): Promise<DiscoveredModel[]> {
  const key = requireKey("google", apiKey);
  const url = new URL(
    appendEndpoint(settings.ai.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta", "/models")
  );
  url.searchParams.set("key", key);
  url.searchParams.set("pageSize", "1000");
  const payload = (await fetchModelsJson("google", url.toString(), { method: "GET" }, signal)) as {
    models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
  };
  const models = (payload.models ?? [])
    .filter((model) => (model.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((model) => toModel("google", String(model.name ?? "").replace(/^models\//, ""), model.displayName));
  return finalize(models);
}

// ---------------------------------------------------------------------------
// Ollama — GET /api/tags (no credentials)
// ---------------------------------------------------------------------------

async function listOllama({ settings, signal }: DiscoverModelsArgs): Promise<DiscoveredModel[]> {
  const payload = (await fetchModelsJson(
    "ollama",
    appendEndpoint(settings.ai.baseUrl ?? "http://127.0.0.1:11434", "/api/tags"),
    { method: "GET" },
    signal
  )) as { models?: Array<{ name?: string; model?: string }> };
  return finalize((payload.models ?? []).map((model) => toModel("ollama", model.name ?? model.model)));
}

// ---------------------------------------------------------------------------
// Amazon Bedrock — GET {control-plane}/foundation-models (SigV4 signed)
// ---------------------------------------------------------------------------

async function listBedrock({ settings, apiKey, signal }: DiscoverModelsArgs): Promise<DiscoveredModel[]> {
  const credentials = parseBedrockCredentials(apiKey);
  if (!credentials) {
    throw new AppError(
      "ai_models_no_key",
      "Add AWS credentials (keychain JSON or AWS_* environment variables) to list Bedrock models."
    );
  }
  const region = credentials.region ?? inferBedrockRegion(settings.ai.baseUrl) ?? "us-east-1";
  // ListFoundationModels lives on the bedrock control plane, not the
  // bedrock-runtime host the chat adapter uses.
  const endpoint = new URL(`https://bedrock.${region}.amazonaws.com/foundation-models`);
  endpoint.searchParams.set("byOutputModality", "TEXT");
  const headers = signAwsJsonRequest({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    region,
    service: "bedrock",
    method: "GET",
    url: endpoint,
    body: ""
  });
  const payload = (await fetchModelsJson("bedrock", endpoint.toString(), { method: "GET", headers }, signal)) as {
    modelSummaries?: Array<{
      modelId?: string;
      modelName?: string;
      providerName?: string;
      outputModalities?: string[];
      inferenceTypesSupported?: string[];
      modelLifecycle?: { status?: string };
    }>;
  };
  const models = (payload.modelSummaries ?? [])
    .filter((model) => (model.outputModalities ?? ["TEXT"]).includes("TEXT"))
    // Keep only models callable directly; provisioned-only models need an
    // inference profile the chat adapter doesn't set up.
    .filter((model) => {
      const types = model.inferenceTypesSupported ?? [];
      return types.length === 0 || types.includes("ON_DEMAND");
    })
    .filter((model) => (model.modelLifecycle?.status ?? "ACTIVE") === "ACTIVE")
    .map((model) =>
      toModel("bedrock", model.modelId, [model.providerName, model.modelName].filter(Boolean).join(" ") || undefined)
    );
  return finalize(models);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toModel(provider: AiProvider, id: string | undefined, label?: string): DiscoveredModel {
  const normalized = String(id ?? "");
  return { id: normalized, label: label || undefined, toolCapable: !modelLikelyLacksToolSupport(provider, normalized) };
}

function requireKey(provider: AiProvider, apiKey: string | null): string {
  if (!apiKey) {
    throw new AppError(
      "ai_models_no_key",
      `Add an API key for ${provider} in Settings → AI Review to list available models.`
    );
  }
  return apiKey;
}

function finalize(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  const result: DiscoveredModel[] = [];
  for (const model of models) {
    if (!model.id || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    result.push(model);
    if (result.length >= MAX_MODELS) {
      break;
    }
  }
  return result;
}

async function fetchModelsJson(
  provider: AiProvider,
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: withTimeout(signal) });
  } catch (error) {
    if (signal?.aborted) {
      throw new AppError("operation_cancelled", "Model discovery was cancelled.", { retryable: true });
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError("ai_models_failed", `Could not reach ${provider} to list models: ${reason}.`, {
      retryable: true
    });
  }

  if (!response.ok) {
    throw mapModelsHttpError(provider, response.status, await safeText(response));
  }

  try {
    return await response.json();
  } catch {
    throw new AppError("ai_models_failed", `The ${provider} model list response was not valid JSON.`, {
      retryable: true
    });
  }
}

function mapModelsHttpError(provider: AiProvider, status: number, body: string): AppError {
  if (status === 401 || status === 403) {
    return new AppError(
      "ai_models_no_key",
      `${provider} rejected the credentials while listing models. Check the API key and try again.`
    );
  }
  const detail = body.trim().slice(0, 200);
  return new AppError(
    "ai_models_failed",
    `Listing ${provider} models failed (HTTP ${status})${detail ? `: ${detail}` : ""}.`,
    { retryable: status >= 500 || status === 429 }
  );
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Bound every discovery request with a timeout, and abort early if the caller's
// signal fires. Built without AbortSignal.any so it doesn't depend on that lib.
function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  if (!signal) {
    return timeout;
  }
  const controller = new AbortController();
  const abort = (reason: unknown): void => controller.abort(reason);
  if (signal.aborted) {
    abort(signal.reason);
  } else if (timeout.aborted) {
    abort(timeout.reason);
  } else {
    signal.addEventListener("abort", () => abort(signal.reason), { once: true });
    timeout.addEventListener("abort", () => abort(timeout.reason), { once: true });
  }
  return controller.signal;
}
