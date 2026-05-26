const TOKEN_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_API_KEY]"
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED_AWS_ACCESS_KEY]"
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    replacement: "[REDACTED_SLACK_TOKEN]"
  }
];

const AUTH_HEADER_PATTERN = /\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s"',;]+/gi;
const EMBEDDED_CREDENTIAL_URL_PATTERN = /\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)[A-Za-z0-9_]*)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

export function redactTextForAi(text: string): string {
  let redacted = text;
  for (const { pattern, replacement } of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted
    .replace(AUTH_HEADER_PATTERN, "$1[REDACTED_AUTH_HEADER]")
    .replace(EMBEDDED_CREDENTIAL_URL_PATTERN, "$1[REDACTED_CREDENTIALS]@")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1$2[REDACTED_SECRET]");
}

export function redactForAi<T>(value: T): T {
  if (typeof value === "string") {
    return redactTextForAi(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactForAi(item)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactForAi(item)])
    ) as T;
  }

  return value;
}
