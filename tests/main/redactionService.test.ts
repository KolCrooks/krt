// @vitest-environment node
import { describe, expect, it } from "vitest";
import { redactForAi, redactTextForAi } from "../../src/main/services/redactionService.js";

describe("redactionService", () => {
  it("redacts common tokens, headers, and private key blocks", () => {
    const text = [
      "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      "OPENAI_API_KEY=sk-project_abcdefghijklmnopqrstuvwxyz123456",
      "aws=AKIA1234567890ABCDEF",
      "url=https://user:pass@example.com/repo.git",
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
    ].join("\n");

    const redacted = redactTextForAi(text);

    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("sk-project_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted).not.toContain("user:pass");
    expect(redacted).not.toContain("abc123");
    expect(redacted).toContain("[REDACTED_AUTH_HEADER]");
    expect(redacted).toContain("[REDACTED_SECRET]");
    expect(redacted).toContain("[REDACTED_AWS_ACCESS_KEY]");
    expect(redacted).toContain("https://[REDACTED_CREDENTIALS]@example.com/repo.git");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts nested prompt values without mutating the original object", () => {
    const input = {
      body: "client_secret: super-secret-value",
      files: [{ patch: "+ token = 'github_pat_abcdefghijklmnopqrstuvwxyz123456'" }]
    };

    const redacted = redactForAi(input);

    expect(input.files[0]?.patch).toContain("github_pat_abcdefghijklmnopqrstuvwxyz123456");
    expect(redacted.body).toBe("client_secret: [REDACTED_SECRET]");
    expect(redacted.files[0]?.patch).toContain("[REDACTED_SECRET]");
    expect(redacted.files[0]?.patch).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz123456");
  });
});
