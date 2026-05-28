import { createHash, createHmac, randomUUID } from "node:crypto";
import type {
  ActivityEvent,
  AppSettings,
  AiProvider,
  ChangedFile,
  CheckRun,
  PullRequestDetail,
  RepositoryRef,
  ReviewThread,
  ReviewTour,
  TourChapter
} from "../../shared/schemas.js";
import { reviewTourSchema, tourChapterSchema } from "../../shared/schemas.js";
import type { SqliteDatabase } from "./database.js";
import type { Keychain } from "./keychain.js";
import { redactForAi } from "./redactionService.js";
import { buildAiReviewPrompt } from "../../shared/aiPrompt.js";
import { extractStreamedChapters } from "../../shared/streamingTour.js";
import { AppError } from "../errors.js";

const TOUR_SYSTEM_PROMPT =
  [
    "You generate structured pull request review tours for experienced code reviewers.",
    "Use the supplied JSON context as the only source of truth.",
    "Prioritize review order, risk, dependencies, verification steps, and concrete file anchors over broad summaries.",
    "Return exactly one valid JSON object matching the requested ReviewTour shape. Do not include markdown, comments, or explanatory text."
  ].join(" ");
const ANTHROPIC_VERSION = "2023-06-01";
const AZURE_OPENAI_API_VERSION = "2024-10-21";
// Full regenerations are only used for transient transport failures (5xx, rate
// limits, network). A response that parses badly is repaired in place instead.
const TOUR_GENERATION_ATTEMPTS = 2;
const TOUR_CORRECTION_ATTEMPTS = 2;

const TOUR_SHAPE_HINT =
  '{ "chapters": [ { "id", "title", "summary", "files": [string], ' +
  '"diffAnchors": [{ "path", "side": "left"|"right" }], ' +
  '"changeStats": { "additions": int, "deletions": int, "files": int }, ' +
  '"riskLevel": "low"|"medium"|"high", "riskReasons": [string], "reviewChecklist": [string], ' +
  '"dependencies": [chapterId] } ], ' +
  '"graph": { "nodes": [{ "id", "label", "riskLevel", "files": [string] }], ' +
  '"edges": [{ "id", "from": chapterId, "to": chapterId, ' +
  '"relation": "dependency"|"extension"|"gating"|"verification"|"risk", "confidence": 0..1, "source": "ai" }] }, ' +
  '"riskSignals": [{ "id", "level": "low"|"medium"|"high", "title", "files": [string], "reason" }] }';

function buildCorrectionPrompt(badContent: string): string {
  return [
    "Your previous response was meant to be a single JSON object matching the ReviewTour schema, but it could not be parsed into a valid tour.",
    "Return ONLY a corrected JSON object — no markdown, code fences, comments, or prose.",
    "Preserve the original content and intent; fix only the structure, field names, enum values, and any truncation.",
    `Required shape: ${TOUR_SHAPE_HINT}`,
    "",
    "Invalid response to correct:",
    badContent
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AiGenerationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; message: string; percent: number; tour?: ReviewTour }) => void;
}

export class AiService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly keychain: Keychain,
    private readonly getSettings: () => AppSettings
  ) {}

  getCachedTour(repository: RepositoryRef, number: number, headSha: string): ReviewTour | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM ai_tours
         WHERE provider = ? AND owner = ? AND repo = ? AND number = ? AND head_sha = ?`
      )
      .get(repository.provider, repository.owner, repository.name, number, headSha) as { payload: string } | undefined;

    return row ? reviewTourSchema.parse(JSON.parse(row.payload)) : null;
  }

  async generateTour(input: {
    pullRequest: PullRequestDetail;
    changedFiles: ChangedFile[];
    timeline: ActivityEvent[];
    reviewThreads: ReviewThread[];
    checks: CheckRun[];
    force?: boolean;
  }, options: AiGenerationOptions = {}): Promise<ReviewTour> {
    assertNotAborted(options.signal);
    const cached = input.force ? null : this.getCachedTour(input.pullRequest.repository, input.pullRequest.number, input.pullRequest.headSha);
    if (cached) {
      options.onProgress?.({ phase: "cache", message: "Loaded AI tour from cache", percent: 100 });
      return cached;
    }

    const settings = this.getSettings();
    if (!settings.ai.enabled || settings.ai.provider === "disabled") {
      throw new AppError(
        "ai_disabled",
        "AI review is turned off. Enable a provider in Settings → AI Review to generate a tour."
      );
    }
    options.onProgress?.({ phase: "prepare", message: "Preparing AI review context", percent: 20 });
    assertNotAborted(options.signal);
    const tour = await this.runTourGenerationWithRetries(input, settings, options);
    assertNotAborted(options.signal);
    options.onProgress?.({ phase: "model", message: "AI provider returned a structured tour", percent: 75 });
    options.onProgress?.({ phase: "persist", message: "Persisting AI tour", percent: 90 });

    this.db
      .prepare(
        `INSERT INTO ai_tours (provider, owner, repo, number, head_sha, payload, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, owner, repo, number, head_sha)
         DO UPDATE SET payload = excluded.payload, generated_at = excluded.generated_at`
      )
      .run(
        input.pullRequest.repository.provider,
        input.pullRequest.repository.owner,
        input.pullRequest.repository.name,
        input.pullRequest.number,
        input.pullRequest.headSha,
        JSON.stringify(tour),
        tour.generatedAt
      );

    return tour;
  }

  private async fetchProviderContent(
    input: {
      pullRequest: PullRequestDetail;
      changedFiles: ChangedFile[];
      timeline: ActivityEvent[];
      reviewThreads: ReviewThread[];
      checks: CheckRun[];
    },
    settings: AppSettings,
    signal?: AbortSignal,
    onStreamText?: (textSoFar: string) => void
  ): Promise<string> {
    const provider = settings.ai.provider;
    const apiKey = await this.resolveApiKey(settings);
    if (provider !== "ollama" && provider !== "bedrock" && !apiKey) {
      throw new AppError(
        "ai_no_key",
        `No API key is configured for ${provider}. Add one in Settings → AI Review before generating a tour.`
      );
    }

    assertNotAborted(signal);
    const prompt = buildAiReviewPrompt(redactForAi(input));
    const streamFormat = STREAM_FORMATS[provider];

    let response: Response | null;
    try {
      response = await requestAiProvider(settings, prompt, apiKey, signal, Boolean(streamFormat));
    } catch (error) {
      assertNotAborted(signal);
      throw new AppError(
        "ai_request_failed",
        `The ${provider} request could not be completed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true }
      );
    }

    if (!response) {
      throw new AppError("ai_not_configured", `The ${provider} provider is not fully configured.`);
    }
    if (!response.ok) {
      // Retry transient server/rate-limit errors; surface client errors (bad key,
      // bad request) immediately since retrying will not help.
      const retryable = response.status >= 500 || response.status === 429;
      throw new AppError(
        "ai_provider_error",
        `The ${provider} request failed with status ${response.status}.`,
        { retryable }
      );
    }

    assertNotAborted(signal);
    let content: string | null;
    if (streamFormat && response.body) {
      // Stream the response so the caller can render the story as it is written.
      content = await readProviderStream(response, streamFormat, signal, onStreamText ?? (() => {}));
    } else {
      const payload = await response.json();
      content = extractProviderText(provider, payload);
    }
    if (!content) {
      throw new AppError("ai_empty_response", `The ${provider} provider returned an empty response.`, { retryable: true });
    }
    return content;
  }

  // Ask the model to repair a response that came back but could not be parsed
  // into a valid tour. Cheaper and more reliable than regenerating from scratch:
  // it sends the broken output plus the expected shape and asks for corrected
  // JSON only. Returns the corrected raw content, or null if the call fails.
  private async requestCorrection(settings: AppSettings, badContent: string, signal?: AbortSignal): Promise<string | null> {
    const provider = settings.ai.provider;
    const apiKey = await this.resolveApiKey(settings);
    if (provider !== "ollama" && provider !== "bedrock" && !apiKey) {
      return null;
    }
    // Correction is a small structural fix — no thinking, no streaming needed.
    const correctionSettings: AppSettings = { ...settings, ai: { ...settings.ai, thinkingEnabled: false } };
    let response: Response | null;
    try {
      response = await requestAiProvider(correctionSettings, buildCorrectionPrompt(badContent), apiKey, signal, false);
    } catch {
      assertNotAborted(signal);
      return null;
    }
    if (!response || !response.ok) {
      return null;
    }
    assertNotAborted(signal);
    const payload = await response.json();
    return extractProviderText(provider, payload);
  }

  private async runTourGenerationWithRetries(
    input: {
      pullRequest: PullRequestDetail;
      changedFiles: ChangedFile[];
      timeline: ActivityEvent[];
      reviewThreads: ReviewThread[];
      checks: CheckRun[];
    },
    settings: AppSettings,
    options: AiGenerationOptions
  ): Promise<ReviewTour> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TOUR_GENERATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(options.signal);
      if (attempt > 1) {
        options.onProgress?.({
          phase: "retry",
          message: `Retrying tour generation (attempt ${attempt} of ${TOUR_GENERATION_ATTEMPTS})…`,
          percent: 24
        });
      }
      try {
        return await this.attemptTourGeneration(input, settings, options);
      } catch (error) {
        // Never retry a cancellation or a non-retryable failure (bad key, 4xx, …).
        if (options.signal?.aborted || (error instanceof AppError && !error.retryable)) {
          throw error;
        }
        lastError = error;
        if (attempt < TOUR_GENERATION_ATTEMPTS) {
          await sleep(250 * attempt);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AppError("ai_invalid_tour", "The provider did not return a valid review tour after several attempts.");
  }

  private async attemptTourGeneration(
    input: {
      pullRequest: PullRequestDetail;
      changedFiles: ChangedFile[];
      timeline: ActivityEvent[];
      reviewThreads: ReviewThread[];
      checks: CheckRun[];
    },
    settings: AppSettings,
    options: AiGenerationOptions
  ): Promise<ReviewTour> {
    const streamId = randomUUID();
    const streamGeneratedAt = new Date().toISOString();
    const streamModel = settings.ai.model || settings.ai.provider;
    options.onProgress?.({ phase: "generate", message: "Waiting for the model…", percent: 28 });
    let streamedChapterCount = 0;
    let lastUpdateAt = Date.now();
    let content = await this.fetchProviderContent(input, settings, options.signal, (textSoFar) => {
      const rawChapters = extractStreamedChapters(textSoFar);
      if (rawChapters.length > streamedChapterCount) {
        const partial = assemblePartialTour({
          rawChapters,
          pullRequest: input.pullRequest,
          id: streamId,
          generatedAt: streamGeneratedAt,
          model: streamModel
        });
        if (partial) {
          streamedChapterCount = partial.chapters.length;
          lastUpdateAt = Date.now();
          options.onProgress?.({
            phase: "stream",
            message: `Writing chapter ${partial.chapters.length}…`,
            percent: Math.min(70, 32 + partial.chapters.length * 6),
            tour: partial
          });
          return;
        }
      }
      // Throttled heartbeat so the UI keeps moving while the model thinks or
      // writes the first chapter (no complete chapter to show yet).
      const now = Date.now();
      if (now - lastUpdateAt >= 400) {
        lastUpdateAt = now;
        options.onProgress?.({
          phase: "generate",
          message: textSoFar.length === 0 ? "Model is thinking…" : "Generating tour…",
          percent: Math.min(68, 30 + Math.floor(textSoFar.length / 400))
        });
      }
    });

    const fillModel = settings.ai.model || settings.ai.provider;
    let tour = parseProviderTour(content, input.pullRequest, fillModel);
    // If the response came back but could not be parsed, ask the model to fix
    // its own output rather than regenerating the whole tour from scratch.
    for (let correction = 1; !tour && correction <= TOUR_CORRECTION_ATTEMPTS; correction += 1) {
      assertNotAborted(options.signal);
      options.onProgress?.({
        phase: "repair",
        message: `Asking the model to fix the tour format (attempt ${correction})…`,
        percent: 72
      });
      const corrected = await this.requestCorrection(settings, content, options.signal);
      if (!corrected) {
        break;
      }
      content = corrected;
      tour = parseProviderTour(content, input.pullRequest, fillModel);
    }
    if (!tour) {
      throw new AppError(
        "ai_invalid_tour",
        `The ${settings.ai.provider} provider did not return a valid review tour, and the correction attempt failed. Try regenerating or adjusting the model.`,
        { retryable: false }
      );
    }
    return tour;
  }

  async hasConfiguredApiKey(): Promise<boolean> {
    const settings = this.getSettings();
    if (settings.ai.provider === "ollama") {
      return true;
    }
    return Boolean(await this.resolveApiKey(settings));
  }

  private async resolveApiKey(settings: AppSettings): Promise<string | null> {
    switch (settings.ai.keyProvider) {
      case "environment":
        return process.env.AI_API_KEY ?? null;
      case "command":
        return this.keychain.getCommandSecret(settings.ai.keyCommand);
      case "keychain":
      default:
        return await this.keychain.getSecret("AI_API_KEY");
    }
  }

}

async function requestAiProvider(
  settings: AppSettings,
  prompt: string,
  apiKey: string | null,
  signal?: AbortSignal,
  stream = false
): Promise<Response | null> {
  switch (settings.ai.provider) {
    case "openai":
      return fetchOpenAi(settings, prompt, apiKey, signal, stream);
    case "azure-openai":
      return fetchAzureOpenAi(settings, prompt, apiKey, signal, stream);
    case "anthropic":
      return fetchAnthropic(settings, prompt, apiKey, signal, stream);
    case "google":
      return fetchGoogle(settings, prompt, apiKey, signal);
    case "ollama":
      return fetchOllama(settings, prompt, signal, stream);
    case "bedrock":
      return fetchBedrock(settings, prompt, apiKey, signal);
    case "disabled":
      return null;
  }
}

function fetchOpenAi(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal, stream = false): Promise<Response> | null {
  if (!apiKey) {
    return null;
  }

  return fetch(appendEndpoint(settings.ai.baseUrl ?? "https://api.openai.com/v1", "/chat/completions"), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: settings.ai.model || "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: TOUR_SYSTEM_PROMPT
        },
        { role: "user", content: prompt }
      ],
      max_completion_tokens: settings.ai.maxOutputTokens,
      response_format: { type: "json_object" },
      ...(stream ? { stream: true } : {})
    })
  });
}

function fetchAzureOpenAi(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal, stream = false): Promise<Response> | null {
  if (!apiKey || !settings.ai.baseUrl) {
    return null;
  }

  return fetch(buildAzureOpenAiEndpoint(settings.ai.baseUrl, settings.ai.model || "default"), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "api-key": apiKey
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: TOUR_SYSTEM_PROMPT
        },
        { role: "user", content: prompt }
      ],
      max_completion_tokens: settings.ai.maxOutputTokens,
      response_format: { type: "json_object" },
      ...(stream ? { stream: true } : {})
    })
  });
}

function fetchAnthropic(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal, stream = false): Promise<Response> | null {
  if (!apiKey) {
    return null;
  }

  const model = settings.ai.model || "claude-sonnet-4-5";
  const thinking = settings.ai.thinkingEnabled && modelSupportsThinking(model);
  return fetch(appendEndpoint(settings.ai.baseUrl ?? "https://api.anthropic.com", "/v1/messages"), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model,
      max_tokens: settings.ai.maxOutputTokens,
      // Extended thinking lets the model reason about review order, risk, and the
      // dependency graph before emitting the structured tour. budget must be < max_tokens.
      ...(thinking
        ? { thinking: { type: "enabled", budget_tokens: thinkingBudgetFor(settings) } }
        : {}),
      system: TOUR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      ...(stream ? { stream: true } : {})
    })
  });
}

function fetchGoogle(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal): Promise<Response> | null {
  if (!apiKey) {
    return null;
  }

  const model = encodeURIComponent(settings.ai.model || "gemini-2.5-flash");
  const endpoint = new URL(appendEndpoint(settings.ai.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta", `/models/${model}:generateContent`));
  endpoint.searchParams.set("key", apiKey);

  return fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: TOUR_SYSTEM_PROMPT }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: settings.ai.maxOutputTokens
      }
    })
  });
}

function fetchOllama(settings: AppSettings, prompt: string, signal?: AbortSignal, stream = false): Promise<Response> {
  return fetch(appendEndpoint(settings.ai.baseUrl ?? "http://127.0.0.1:11434", "/api/chat"), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: settings.ai.model || "llama3.1",
      messages: [{ role: "user", content: prompt }],
      stream,
      format: "json",
      options: { num_predict: settings.ai.maxOutputTokens }
    })
  });
}

function fetchBedrock(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal): Promise<Response> | null {
  const credentials = parseBedrockCredentials(apiKey);
  if (!credentials) {
    return null;
  }

  const region = credentials.region ?? inferBedrockRegion(settings.ai.baseUrl) ?? "us-east-1";
  const baseUrl = settings.ai.baseUrl ?? `https://bedrock-runtime.${region}.amazonaws.com`;
  const modelId = settings.ai.model || "anthropic.claude-3-5-sonnet-20241022-v2:0";
  const endpoint = new URL(`${baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(modelId)}/converse`);
  const thinking = settings.ai.thinkingEnabled && modelSupportsThinking(modelId);
  const body = JSON.stringify({
    system: [{ text: TOUR_SYSTEM_PROMPT }],
    messages: [
      {
        role: "user",
        content: [{ text: prompt }]
      }
    ],
    inferenceConfig: {
      maxTokens: settings.ai.maxOutputTokens,
      // Extended thinking requires the default temperature, so only set it when off.
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

  return fetch(endpoint, {
    method: "POST",
    signal,
    headers,
    body
  });
}

function extractProviderText(provider: AiProvider, payload: unknown): string | null {
  const value = payload as {
    message?: { content?: string };
    choices?: Array<{ message?: { content?: string } }>;
    content?: Array<{ type?: string; text?: string }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    output?: { message?: { content?: Array<{ text?: string }> } };
  };

  switch (provider) {
    case "openai":
    case "azure-openai":
      return value.choices?.[0]?.message?.content ?? null;
    case "ollama":
      return value.message?.content ?? null;
    case "anthropic":
      return joinTextParts(value.content);
    case "google":
      return joinTextParts(value.candidates?.[0]?.content?.parts);
    case "bedrock":
      return joinTextParts(value.output?.message?.content);
    case "disabled":
      return null;
  }
}

function joinTextParts(parts: Array<{ text?: string }> | undefined): string | null {
  const text = parts?.map((part) => part.text ?? "").join("").trim() ?? "";
  return text || null;
}

interface StreamFormat {
  transport: "sse" | "ndjson";
  extractDelta: (event: unknown) => string | null;
}

function openAiStreamDelta(event: unknown): string | null {
  const value = event as { choices?: Array<{ delta?: { content?: string } }> };
  return value.choices?.[0]?.delta?.content ?? null;
}

// Providers whose responses can be consumed incrementally. Google uses a
// different streaming endpoint and Bedrock a binary event stream, so both stay
// single-shot (one update at completion).
const STREAM_FORMATS: Partial<Record<AiProvider, StreamFormat>> = {
  anthropic: {
    transport: "sse",
    extractDelta: (event) => {
      const value = event as { type?: string; delta?: { type?: string; text?: string } };
      return value.type === "content_block_delta" && value.delta?.type === "text_delta"
        ? value.delta.text ?? null
        : null;
    }
  },
  openai: { transport: "sse", extractDelta: openAiStreamDelta },
  "azure-openai": { transport: "sse", extractDelta: openAiStreamDelta },
  ollama: {
    transport: "ndjson",
    extractDelta: (event) => (event as { message?: { content?: string } }).message?.content ?? null
  }
};

async function readProviderStream(
  response: Response,
  format: StreamFormat,
  signal: AbortSignal | undefined,
  onText: (textSoFar: string) => void
): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  try {
    for (;;) {
      assertNotAborted(signal);
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        let payload = line;
        if (format.transport === "sse") {
          if (!line.startsWith("data:")) {
            // Skip SSE framing such as `event:`, `id:`, and `:` keep-alive comments.
            continue;
          }
          payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            continue;
          }
        }
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = format.extractDelta(event);
        if (delta) {
          full += delta;
        }
        // Fire on every parsed event — including thinking/keep-alive events that
        // produce no text — so callers can show live progress while the model
        // reasons before emitting the tour.
        onText(full);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return full;
}

// Build a schema-valid ReviewTour from the chapters streamed so far. Chapters
// that have not fully arrived (or fail validation) are skipped; the graph is
// nodes-only until the final parse fills in edges and risk signals.
function assemblePartialTour(args: {
  rawChapters: unknown[];
  pullRequest: PullRequestDetail;
  id: string;
  generatedAt: string;
  model: string;
}): ReviewTour | null {
  const { rawChapters, pullRequest, id, generatedAt, model } = args;
  const chapters: TourChapter[] = [];
  for (const raw of rawChapters) {
    const chapter = normalizeChapter(raw, chapters.length, { generatedAt, model, headSha: pullRequest.headSha });
    if (chapter) {
      chapters.push(chapter);
    }
  }
  if (chapters.length === 0) {
    return null;
  }

  const result = reviewTourSchema.safeParse({
    id,
    provider: pullRequest.provider,
    repository: pullRequest.repository,
    pullNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    generatedAt,
    model,
    chapters,
    graph: {
      nodes: chapters.map((chapter) => ({
        id: chapter.id,
        label: chapter.title,
        riskLevel: chapter.riskLevel,
        files: chapter.files
      })),
      edges: []
    },
    riskSignals: []
  });
  return result.success ? result.data : null;
}

function parseProviderTour(content: string, pullRequest: PullRequestDetail, model: string): ReviewTour | null {
  const json = extractJsonObject(content);
  if (json) {
    try {
      // Lenient normalization: defaults and coerces fields so a slightly-off
      // model response (renamed/missing field, out-of-enum value) still yields
      // a valid tour instead of being rejected wholesale.
      const tour = normalizeProviderTour(JSON.parse(json), pullRequest, model);
      if (tour) {
        return tour;
      }
    } catch {
      // The JSON tail was truncated — fall back to salvaging streamed chapters.
    }
  }
  return salvageProviderTour(content, pullRequest, model);
}

type EdgeRelation = "dependency" | "extension" | "gating" | "verification" | "risk";

const RELATION_SYNONYMS: Record<string, EdgeRelation> = {
  dependency: "dependency",
  depends: "dependency",
  "depends-on": "dependency",
  depends_on: "dependency",
  uses: "dependency",
  requires: "dependency",
  extension: "extension",
  extends: "extension",
  gating: "gating",
  gates: "gating",
  gate: "gating",
  "gated-by": "gating",
  gated_by: "gating",
  verification: "verification",
  verifies: "verification",
  verify: "verification",
  tests: "verification",
  "verified-by": "verification",
  risk: "risk",
  "risk-to": "risk"
};

// Build a valid ReviewTour from a provider response that failed strict parsing.
// Chapters are recovered with the tolerant streaming extractor (so a truncated
// tail still yields every complete chapter); the graph is rebuilt from those
// chapters and the model's edges are coerced into the expected shape. Returns
// null only when not a single chapter can be recovered.
function salvageProviderTour(content: string, pullRequest: PullRequestDetail, model: string): ReviewTour | null {
  const generatedAt = new Date().toISOString();
  const headSha = pullRequest.headSha;

  const chapters: TourChapter[] = [];
  for (const raw of extractStreamedChapters(content)) {
    const chapter = normalizeChapter(raw, chapters.length, { generatedAt, model, headSha });
    if (chapter) {
      chapters.push(chapter);
    }
  }
  if (chapters.length === 0) {
    return null;
  }
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));

  // Recover the model's edges and risk signals when the full object still parses.
  let rawEdges: unknown[] = [];
  let rawRiskSignals: unknown[] = [];
  const json = extractJsonObject(content);
  if (json) {
    try {
      const object = JSON.parse(json) as { graph?: { edges?: unknown }; riskSignals?: unknown };
      if (Array.isArray(object.graph?.edges)) {
        rawEdges = object.graph.edges;
      }
      if (Array.isArray(object.riskSignals)) {
        rawRiskSignals = object.riskSignals;
      }
    } catch {
      // Truncated JSON — keep the chapters and drop the unreachable tail.
    }
  }

  const result = reviewTourSchema.safeParse({
    id: randomUUID(),
    provider: pullRequest.provider,
    repository: pullRequest.repository,
    pullNumber: pullRequest.number,
    headSha,
    generatedAt,
    model,
    chapters,
    graph: {
      nodes: chapters.map((chapter) => ({
        id: chapter.id,
        label: chapter.title,
        riskLevel: chapter.riskLevel,
        files: chapter.files
      })),
      edges: coerceTourEdges(rawEdges, chapterIds)
    },
    riskSignals: coerceRiskSignals(rawRiskSignals)
  });
  return result.success ? result.data : null;
}

function coerceTourEdges(rawEdges: unknown[], chapterIds: Set<string>): ReviewTour["graph"]["edges"] {
  const edges: ReviewTour["graph"]["edges"] = [];
  const seen = new Set<string>();
  let counter = 0;
  for (const raw of rawEdges) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as { id?: unknown; from?: unknown; to?: unknown; relation?: unknown; confidence?: unknown };
    const from = String(record.from ?? "");
    const to = String(record.to ?? "");
    if (from === to || !chapterIds.has(from) || !chapterIds.has(to)) {
      continue;
    }
    const key = `${from}->${to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const relation = RELATION_SYNONYMS[String(record.relation ?? "").toLowerCase().trim()] ?? "dependency";
    let confidence = typeof record.confidence === "number" ? record.confidence : 0.6;
    if (confidence > 1) {
      confidence = confidence / 100;
    }
    confidence = Math.max(0, Math.min(1, confidence));
    edges.push({
      id: typeof record.id === "string" ? record.id : `edge-${(counter += 1)}`,
      from,
      to,
      relation,
      confidence,
      source: "ai"
    });
  }
  return edges;
}

function coerceRiskSignals(rawSignals: unknown[]): ReviewTour["riskSignals"] {
  const signals: ReviewTour["riskSignals"] = [];
  let counter = 0;
  for (const raw of rawSignals) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as { id?: unknown; level?: unknown; title?: unknown; files?: unknown; reason?: unknown };
    if (record.level !== "low" && record.level !== "medium" && record.level !== "high") {
      continue;
    }
    if (typeof record.title !== "string" || typeof record.reason !== "string") {
      continue;
    }
    signals.push({
      id: typeof record.id === "string" ? record.id : `risk-${(counter += 1)}`,
      level: record.level,
      title: record.title,
      files: Array.isArray(record.files) ? record.files.filter((file): file is string => typeof file === "string") : [],
      reason: record.reason
    });
  }
  return signals;
}

// Build a valid ReviewTour from a fully-parsed model object, defaulting and
// coercing each field so a slightly-off response is accepted rather than
// rejected. Returns null only when no chapter can be recovered.
function normalizeProviderTour(raw: unknown, pullRequest: PullRequestDetail, model: string): ReviewTour | null {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const generatedAt = asString(root.generatedAt) ?? new Date().toISOString();
  const headSha = pullRequest.headSha;
  const rawChapters = Array.isArray(root.chapters) ? root.chapters : Array.isArray(raw) ? (raw as unknown[]) : [];
  const chapters: TourChapter[] = [];
  for (const rawChapter of rawChapters) {
    const chapter = normalizeChapter(rawChapter, chapters.length, { generatedAt, model, headSha });
    if (chapter) {
      chapters.push(chapter);
    }
  }
  if (chapters.length === 0) {
    return null;
  }
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));
  const graph = root.graph && typeof root.graph === "object" ? (root.graph as Record<string, unknown>) : {};
  const result = reviewTourSchema.safeParse({
    id: asString(root.id) ?? randomUUID(),
    provider: pullRequest.provider,
    repository: pullRequest.repository,
    pullNumber: pullRequest.number,
    headSha,
    generatedAt,
    model,
    chapters,
    graph: {
      nodes: chapters.map((chapter) => ({ id: chapter.id, label: chapter.title, riskLevel: chapter.riskLevel, files: chapter.files })),
      edges: coerceTourEdges(Array.isArray(graph.edges) ? graph.edges : [], chapterIds)
    },
    riskSignals: coerceRiskSignals(Array.isArray(root.riskSignals) ? root.riskSignals : [])
  });
  return result.success ? result.data : null;
}

function normalizeChapter(
  raw: unknown,
  index: number,
  fill: { generatedAt: string; model: string; headSha: string }
): TourChapter | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const files = toStringArray(record.files);
  const stats = record.changeStats && typeof record.changeStats === "object" ? (record.changeStats as Record<string, unknown>) : {};
  const candidate = {
    id: asString(record.id) ?? `chapter-${index + 1}`,
    title: asString(record.title) ?? asString(record.name) ?? `Chapter ${index + 1}`,
    summary: asString(record.summary) ?? asString(record.description) ?? "",
    files,
    diffAnchors: coerceDiffAnchors(record.diffAnchors, files),
    changeStats: {
      additions: toNonNegativeInt(stats.additions ?? record.additions),
      deletions: toNonNegativeInt(stats.deletions ?? record.deletions),
      files: toNonNegativeInt(stats.files) || files.length
    },
    riskLevel: coerceRiskLevel(record.riskLevel ?? record.risk),
    riskReasons: toStringArray(record.riskReasons),
    reviewChecklist: toStringArray(record.reviewChecklist ?? record.keyPoints ?? record.checklist),
    dependencies: toStringArray(record.dependencies),
    generatedAt: fill.generatedAt,
    model: fill.model,
    headSha: fill.headSha
  };
  const parsed = tourChapterSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

function toNonNegativeInt(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function coerceRiskLevel(value: unknown): "low" | "medium" | "high" {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("high") || text.includes("crit") || text.includes("sev")) {
    return "high";
  }
  if (text.includes("med") || text.includes("mod")) {
    return "medium";
  }
  return "low";
}

function coerceDiffAnchors(
  value: unknown,
  files: string[]
): Array<{ path: string; startLine?: number; endLine?: number; side: "left" | "right" }> {
  const anchors: Array<{ path: string; startLine?: number; endLine?: number; side: "left" | "right" }> = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        anchors.push({ path: entry, side: "right" });
        continue;
      }
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const path = asString(record.path);
        if (!path) {
          continue;
        }
        const start = toNonNegativeInt(record.startLine);
        const end = toNonNegativeInt(record.endLine);
        anchors.push({
          path,
          side: record.side === "left" ? "left" : "right",
          ...(start > 0 ? { startLine: start } : {}),
          ...(end > 0 ? { endLine: end } : {})
        });
      }
    }
  }
  if (anchors.length === 0 && files[0]) {
    anchors.push({ path: files[0], side: "right" });
  }
  return anchors;
}

function extractJsonObject(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return extractJsonObject(fenced[1]);
  }

  const start = trimmed.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = inString;
      continue;
    }
    if (character === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return null;
}

function appendEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith(path)) {
    return trimmed;
  }
  return `${trimmed}${path}`;
}

function buildAzureOpenAiEndpoint(baseUrl: string, deployment: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const endpoint = trimmed.includes("/chat/completions")
    ? trimmed
    : trimmed.includes("/openai/deployments/")
      ? `${trimmed}/chat/completions`
      : `${trimmed}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
  const url = new URL(endpoint);
  if (!url.searchParams.has("api-version")) {
    url.searchParams.set("api-version", AZURE_OPENAI_API_VERSION);
  }
  return url.toString();
}

interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}

function parseBedrockCredentials(secret: string | null): BedrockCredentials | null {
  if (secret) {
    try {
      const parsed = JSON.parse(secret) as Partial<BedrockCredentials>;
      if (parsed.accessKeyId && parsed.secretAccessKey) {
        return {
          accessKeyId: parsed.accessKeyId,
          secretAccessKey: parsed.secretAccessKey,
          sessionToken: parsed.sessionToken,
          region: parsed.region
        };
      }
    } catch {
      // Fall through to environment-based AWS credentials.
    }
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION
  };
}

function inferBedrockRegion(baseUrl?: string): string | null {
  if (!baseUrl) {
    return null;
  }

  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname.match(/^bedrock-runtime(?:-[a-z0-9-]+)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function signAwsJsonRequest(input: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  method: string;
  url: URL;
  body: string;
}): Record<string, string> {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: input.url.host,
    "x-amz-date": amzDate,
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {})
  };
  const signedHeaderNames = Object.keys(headers)
    .map((header) => header.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames.map((header) => `${header}:${headers[header]?.trim() ?? ""}`).join("\n");
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    input.url.searchParams.toString(),
    `${canonicalHeaders}\n`,
    signedHeaderNames.join(";"),
    payloadHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = getAwsSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`
  };
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getAwsSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const dateKey = createHmac("sha256", `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(service).digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError("operation_cancelled", "AI tour generation was cancelled.", { retryable: true });
  }
}

// Keep the thinking budget strictly below the max output budget; the provider
// rejects a budget that meets or exceeds max_tokens.
function thinkingBudgetFor(settings: AppSettings): number {
  return Math.max(1_024, Math.min(settings.ai.thinkingBudgetTokens, settings.ai.maxOutputTokens - 1_024));
}

function modelSupportsThinking(model: string): boolean {
  if (!model) {
    // Default Anthropic model (claude-sonnet-4-5) supports extended thinking.
    return true;
  }
  const normalized = model.toLowerCase();
  const isLegacyClaude =
    /(claude-3-5|claude-3-opus|claude-3-sonnet|claude-3-haiku|claude-2|claude-instant)/.test(normalized) &&
    !/claude-3-7/.test(normalized);
  if (isLegacyClaude) {
    return false;
  }
  return /claude/.test(normalized);
}
