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
import { reviewTourSchema } from "../../shared/schemas.js";
import type { SqliteDatabase } from "./database.js";
import type { Keychain } from "./keychain.js";
import { redactForAi } from "./redactionService.js";
import { buildAiReviewPrompt } from "../../shared/aiPrompt.js";
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

export interface AiGenerationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; message: string; percent: number }) => void;
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
  }, options: AiGenerationOptions = {}): Promise<ReviewTour> {
    assertNotAborted(options.signal);
    const cached = this.getCachedTour(input.pullRequest.repository, input.pullRequest.number, input.pullRequest.headSha);
    if (cached) {
      options.onProgress?.({ phase: "cache", message: "Loaded AI tour from cache", percent: 100 });
      return cached;
    }

    const settings = this.getSettings();
    options.onProgress?.({ phase: "prepare", message: "Preparing AI review context", percent: 20 });
    assertNotAborted(options.signal);
    const generated =
      settings.ai.enabled && settings.ai.provider !== "disabled"
        ? await this.tryGenerateWithConfiguredProvider(input, settings, options.signal)
        : null;
    assertNotAborted(options.signal);
    options.onProgress?.({
      phase: generated ? "model" : "fallback",
      message: generated ? "AI provider returned a structured tour" : "Building deterministic review tour",
      percent: generated ? 75 : 65
    });
    const tour = generated ?? this.generateDeterministicTour(input);
    assertNotAborted(options.signal);
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

  private async tryGenerateWithConfiguredProvider(
    input: {
      pullRequest: PullRequestDetail;
      changedFiles: ChangedFile[];
      timeline: ActivityEvent[];
      reviewThreads: ReviewThread[];
      checks: CheckRun[];
    },
    settings: AppSettings,
    signal?: AbortSignal
  ): Promise<ReviewTour | null> {
    const apiKey = await this.resolveApiKey(settings);
    if (settings.ai.provider !== "ollama" && settings.ai.provider !== "bedrock" && !apiKey) {
      return null;
    }

    assertNotAborted(signal);
    const prompt = buildAiReviewPrompt(redactForAi(input));

    try {
      const response = await requestAiProvider(settings, prompt, apiKey, signal);
      if (!response) {
        return null;
      }

      if (!response.ok) {
        return null;
      }

      assertNotAborted(signal);
      const payload = await response.json();
      const content = extractProviderText(settings.ai.provider, payload);
      if (!content) {
        return null;
      }

      return parseProviderTour(content, input.pullRequest, settings.ai.model || settings.ai.provider);
    } catch {
      assertNotAborted(signal);
      return null;
    }
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

  private generateDeterministicTour(input: {
    pullRequest: PullRequestDetail;
    changedFiles: ChangedFile[];
    checks: CheckRun[];
    reviewThreads: ReviewThread[];
  }): ReviewTour {
    const generatedAt = new Date().toISOString();
    const groups = groupChangedFiles(input.changedFiles);
    const chapters: TourChapter[] = groups.map((group, index) => {
      const additions = group.files.reduce((sum, file) => sum + file.additions, 0);
      const deletions = group.files.reduce((sum, file) => sum + file.deletions, 0);
      const riskLevel = group.files.some((file) => file.isLarge || file.isGenerated) || additions + deletions > 1_500 ? "high" : additions + deletions > 300 ? "medium" : "low";

      return {
        id: `chapter-${index + 1}`,
        title: group.title,
        summary: summarizeGroup(group.files),
        files: group.files.map((file) => file.path),
        diffAnchors: group.files.slice(0, 5).map((file) => ({ path: file.path, side: "right" as const })),
        changeStats: {
          additions,
          deletions,
          files: group.files.length
        },
        riskLevel,
        riskReasons: riskReasons(group.files, input.checks),
        reviewChecklist: checklistForGroup(group.files),
        dependencies: index > 0 ? [`chapter-${index}`] : [],
        generatedAt,
        model: "deterministic-fallback",
        headSha: input.pullRequest.headSha
      };
    });

    return {
      id: randomUUID(),
      provider: input.pullRequest.provider,
      repository: input.pullRequest.repository,
      pullNumber: input.pullRequest.number,
      headSha: input.pullRequest.headSha,
      generatedAt,
      model: "deterministic-fallback",
      chapters,
      graph: {
        nodes: chapters.map((chapter) => ({
          id: chapter.id,
          label: chapter.title,
          riskLevel: chapter.riskLevel,
          files: chapter.files
        })),
        edges: chapters.slice(1).map((chapter, index) => ({
          id: `edge-${index + 1}`,
          from: `chapter-${index + 1}`,
          to: chapter.id,
          relation: "dependency",
          confidence: 0.55,
          source: "deterministic"
        }))
      },
      riskSignals: chapters
        .filter((chapter) => chapter.riskLevel !== "low")
        .map((chapter) => ({
          id: `risk-${chapter.id}`,
          level: chapter.riskLevel,
          title: chapter.title,
          files: chapter.files,
          reason: chapter.riskReasons[0] ?? "Large or broad change set"
        }))
    };
  }
}

async function requestAiProvider(
  settings: AppSettings,
  prompt: string,
  apiKey: string | null,
  signal?: AbortSignal
): Promise<Response | null> {
  switch (settings.ai.provider) {
    case "openai":
      return fetchOpenAi(settings, prompt, apiKey, signal);
    case "azure-openai":
      return fetchAzureOpenAi(settings, prompt, apiKey, signal);
    case "anthropic":
      return fetchAnthropic(settings, prompt, apiKey, signal);
    case "google":
      return fetchGoogle(settings, prompt, apiKey, signal);
    case "ollama":
      return fetchOllama(settings, prompt, signal);
    case "bedrock":
      return fetchBedrock(settings, prompt, apiKey, signal);
    case "disabled":
      return null;
  }
}

function fetchOpenAi(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal): Promise<Response> | null {
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
      response_format: { type: "json_object" }
    })
  });
}

function fetchAzureOpenAi(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal): Promise<Response> | null {
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
      response_format: { type: "json_object" }
    })
  });
}

function fetchAnthropic(settings: AppSettings, prompt: string, apiKey: string | null, signal?: AbortSignal): Promise<Response> | null {
  if (!apiKey) {
    return null;
  }

  return fetch(appendEndpoint(settings.ai.baseUrl ?? "https://api.anthropic.com", "/v1/messages"), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: settings.ai.model || "claude-sonnet-4-5",
      max_tokens: 4096,
      system: TOUR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }]
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
        temperature: 0.2
      }
    })
  });
}

function fetchOllama(settings: AppSettings, prompt: string, signal?: AbortSignal): Promise<Response> {
  return fetch(appendEndpoint(settings.ai.baseUrl ?? "http://127.0.0.1:11434", "/api/chat"), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: settings.ai.model || "llama3.1",
      messages: [{ role: "user", content: prompt }],
      stream: false,
      format: "json"
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
  const body = JSON.stringify({
    system: [{ text: TOUR_SYSTEM_PROMPT }],
    messages: [
      {
        role: "user",
        content: [{ text: prompt }]
      }
    ],
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0.2
    }
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

function parseProviderTour(content: string, pullRequest: PullRequestDetail, model: string): ReviewTour | null {
  const json = extractJsonObject(content);
  if (!json) {
    return null;
  }

  const parsed = JSON.parse(json) as Partial<ReviewTour>;
  return reviewTourSchema.parse({
    ...parsed,
    id: parsed.id ?? randomUUID(),
    provider: pullRequest.provider,
    repository: pullRequest.repository,
    pullNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    model
  });
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

function groupChangedFiles(files: ChangedFile[]): Array<{ title: string; files: ChangedFile[] }> {
  const buckets = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const firstSegment = file.path.includes("/") ? file.path.split("/")[0] : "root";
    const bucket = buckets.get(firstSegment) ?? [];
    bucket.push(file);
    buckets.set(firstSegment, bucket);
  }

  return [...buckets.entries()]
    .sort(([, left], [, right]) => right.reduce((sum, file) => sum + file.changes, 0) - left.reduce((sum, file) => sum + file.changes, 0))
    .slice(0, 12)
    .map(([segment, groupFiles]) => ({
      title: segment === "root" ? "Top-level changes" : `${segment}/ changes`,
      files: groupFiles
    }));
}

function summarizeGroup(files: ChangedFile[]): string {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return `${files.length} files changed with ${additions} additions and ${deletions} deletions.`;
}

function riskReasons(files: ChangedFile[], checks: CheckRun[]): string[] {
  const reasons = new Set<string>();
  if (files.some((file) => file.isLarge)) {
    reasons.add("Contains large diffs that should be reviewed selectively.");
  }
  if (files.some((file) => file.isGenerated)) {
    reasons.add("Includes generated or vendored-looking files.");
  }
  if (checks.some((check) => check.conclusion === "failure" || check.conclusion === "timed_out")) {
    reasons.add("At least one check is failing or timed out.");
  }
  if (files.reduce((sum, file) => sum + file.changes, 0) > 1_000) {
    reasons.add("Broad change set with more than 1,000 changed lines.");
  }
  return [...reasons];
}

function checklistForGroup(files: ChangedFile[]): string[] {
  const checklist = ["Confirm the changed behavior matches the PR description.", "Inspect tests or coverage for the modified paths."];
  if (files.some((file) => file.status === "removed")) {
    checklist.push("Verify deleted files have no remaining runtime references.");
  }
  if (files.some((file) => file.path.includes("package") || file.path.includes("lock"))) {
    checklist.push("Check dependency and lockfile changes together.");
  }
  return checklist;
}
