import { createHash, createHmac } from "node:crypto";
import type { AppSettings } from "../../../shared/schemas.js";

export const ANTHROPIC_VERSION = "2023-06-01";
export const AZURE_OPENAI_API_VERSION = "2024-10-21";

export function appendEndpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith(path)) {
    return trimmed;
  }
  return `${trimmed}${path}`;
}

export function buildAzureOpenAiEndpoint(baseUrl: string, deployment: string): string {
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

export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}

export function parseBedrockCredentials(secret: string | null): BedrockCredentials | null {
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

export function inferBedrockRegion(baseUrl?: string): string | null {
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

export function signAwsJsonRequest(input: {
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

// Keep the thinking budget strictly below the max output budget; the provider
// rejects a budget that meets or exceeds max_tokens.
export function thinkingBudgetFor(settings: AppSettings): number {
  return Math.max(1_024, Math.min(settings.ai.thinkingBudgetTokens, settings.ai.maxOutputTokens - 1_024));
}

export function modelSupportsThinking(model: string): boolean {
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

export function joinTextParts(parts: Array<{ text?: string }> | undefined): string {
  return parts?.map((part) => part.text ?? "").join("") ?? "";
}

// Pull a single JSON object out of a string that may be wrapped in prose or a
// markdown fence. Used to recover tool-call arguments that arrive as a JSON
// string (OpenAI / Ollama) but may be lightly malformed.
export function extractJsonObject(content: string): string | null {
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

// Tool-call arguments arrive either as a parsed object (Anthropic/Bedrock/
// Google) or as a JSON string (OpenAI/Ollama). Normalize to an object.
export function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const recovered = extractJsonObject(trimmed);
    if (recovered) {
      try {
        return JSON.parse(recovered);
      } catch {
        // Fall through.
      }
    }
    return {};
  }
}
