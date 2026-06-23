// @vitest-environment node
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCommand } from "../../src/main/services/commandResolver.js";

describe("resolveCommand", () => {
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;
  const originalTestCli = process.env.KRT_TEST_CLI;
  const originalTestPath = process.env.KRT_TEST_PATH;

  afterEach(() => {
    restoreEnv("PATH", originalPath);
    restoreEnv("SHELL", originalShell);
    restoreEnv("KRT_TEST_CLI", originalTestCli);
    restoreEnv("KRT_TEST_PATH", originalTestPath);
  });

  it("resolves commands from a login shell when the inherited PATH is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "krt-command-resolver-"));
    const binDir = join(root, "bin");
    const programPath = join(binDir, "krt-test-cli");
    const shellPath = join(root, "fake-shell");
    await mkdir(binDir);
    await writeFile(programPath, "#!/bin/sh\nprintf 'resolved cli\\n'\n");
    await writeFile(shellPath, "#!/bin/sh\nprintf '%s\\n%s\\n' \"$KRT_TEST_CLI\" \"$KRT_TEST_PATH\"\n");
    await chmod(programPath, 0o755);
    await chmod(shellPath, 0o755);

    process.env.PATH = "/usr/bin:/bin";
    process.env.SHELL = shellPath;
    process.env.KRT_TEST_CLI = programPath;
    process.env.KRT_TEST_PATH = `/shell/bin${delimiter}/usr/bin`;

    const resolved = await resolveCommand("krt-test-cli");

    expect(resolved?.program).toBe(programPath);
    expect(resolved?.env.PATH?.split(delimiter)[0]).toBe(binDir);
    expect(resolved?.env.PATH).toContain("/shell/bin");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
