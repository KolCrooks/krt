// @vitest-environment node
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Keychain } from "../../src/main/services/keychain.js";

describe("Keychain", () => {
  it("runs gh auth token through the resolved executable and environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt-gh-token-"));
    const ghPath = join(root, "gh");
    await writeFile(
      ghPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" != \"auth\" ] || [ \"$2\" != \"token\" ]; then",
        "  exit 2",
        "fi",
        "printf '%s\\n' \"$KRT_TEST_GH_TOKEN\""
      ].join("\n")
    );
    await chmod(ghPath, 0o755);
    const resolveExecutable = vi.fn(async () => ({
      program: ghPath,
      env: { ...process.env, KRT_TEST_GH_TOKEN: "resolved-gh-token" }
    }));
    const keychain = new Keychain("test", resolveExecutable);

    await expect(keychain.getGhAuthToken()).resolves.toBe("resolved-gh-token");
    expect(resolveExecutable).toHaveBeenCalledWith("gh");
  });
});
