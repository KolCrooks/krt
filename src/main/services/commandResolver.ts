import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ResolvedCommand {
  program: string;
  env: NodeJS.ProcessEnv;
}

export async function resolveCommand(command: string): Promise<ResolvedCommand | null> {
  if (isPathCommand(command)) {
    return (await isExecutable(command))
      ? { program: command, env: processEnv(prependPath(process.env.PATH, dirname(command))) }
      : null;
  }

  const inheritedPath = process.env.PATH;
  const inheritedProgram = await resolveCommandFromPath(command, inheritedPath);
  if (inheritedProgram) {
    return {
      program: inheritedProgram,
      env: processEnv(prependPath(inheritedPath, dirname(inheritedProgram)))
    };
  }

  const commonPath = appendPaths(inheritedPath, commonExecutableDirs());
  if (commonPath !== inheritedPath) {
    const commonProgram = await resolveCommandFromPath(command, commonPath);
    if (commonProgram) {
      return {
        program: commonProgram,
        env: processEnv(prependPath(commonPath, dirname(commonProgram)))
      };
    }
  }

  const shellResolved = await resolveCommandFromLoginShell(command);
  if (!shellResolved) {
    return null;
  }

  return {
    program: shellResolved.program,
    env: processEnv(prependPath(shellResolved.path, dirname(shellResolved.program)))
  };
}

function processEnv(path?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(path ? { PATH: path } : {})
  };
}

function isPathCommand(command: string): boolean {
  return isAbsolute(command) || command.includes("/") || (sep !== "/" && command.includes(sep));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandFromPath(command: string, path: string | undefined): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [command], {
      env: processEnv(path),
      timeout: 2_000
    });
    return firstLine(String(stdout));
  } catch {
    return null;
  }
}

async function resolveCommandFromLoginShell(command: string): Promise<{ program: string; path: string } | null> {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(
      shell,
      [
        "-lc",
        'resolved=$(command -v -- "$1" 2>/dev/null || true); printf "%s\\n%s" "$resolved" "$PATH"',
        "krt-resolve-command",
        command
      ],
      { timeout: 3_000 }
    );
    const [programLine, ...pathLines] = String(stdout).split("\n");
    const program = programLine.trim();
    if (!program) {
      return null;
    }
    return {
      program,
      path: pathLines.join("\n").trim()
    };
  } catch {
    return null;
  }
}

function firstLine(value: string): string | null {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function prependPath(path: string | undefined, entry: string): string {
  return appendPaths(path, [entry], true);
}

function appendPaths(path: string | undefined, entries: string[], prepend = false): string {
  const parts = (path ?? "").split(delimiter).filter(Boolean);
  for (const entry of entries) {
    if (parts.includes(entry)) {
      continue;
    }
    if (prepend) {
      parts.unshift(entry);
    } else {
      parts.push(entry);
    }
  }
  return parts.join(delimiter);
}

function commonExecutableDirs(): string[] {
  const home = process.env.HOME ?? homedir();
  return [
    ...appExecutableDirs(),
    home ? join(home, ".cargo", "bin") : null,
    home ? join(home, ".pyenv", "shims") : null,
    home ? join(home, ".local", "bin") : null,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter((entry): entry is string => Boolean(entry));
}

function appExecutableDirs(): string[] {
  const dirs = new Set<string>([join(process.cwd(), "node_modules", ".bin")]);
  try {
    dirs.add(fileURLToPath(new URL("../../../node_modules/.bin/", import.meta.url)));
  } catch {
    // import.meta.url can be non-file in tests or future bundling modes.
  }
  if (process.resourcesPath) {
    dirs.add(join(process.resourcesPath, "app.asar.unpacked", "node_modules", ".bin"));
    dirs.add(join(process.resourcesPath, "app", "node_modules", ".bin"));
  }
  return [...dirs];
}
