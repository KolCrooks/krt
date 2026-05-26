import type { DataMode, PreferredDataMode } from "./schemas.js";

export interface ModeSelectionInput {
  preferredMode: PreferredDataMode;
  mirrorExists: boolean;
  mirrorFresh: boolean;
  worktreeExists?: boolean;
}

export interface ModeSelection {
  mode: DataMode;
  reason: string;
}

export function selectDataMode(input: ModeSelectionInput): ModeSelection {
  if (input.preferredMode === "light") {
    return { mode: "light", reason: "Light/API mode was explicitly requested." };
  }

  if (input.preferredMode === "managed") {
    return input.worktreeExists
      ? { mode: "managed", reason: "Managed mode was requested and this pull request is checked out." }
      : { mode: "light", reason: "Managed mode was requested, but this pull request is not checked out yet." };
  }

  if (input.worktreeExists) {
    return { mode: "managed", reason: "A managed checkout exists for this pull request." };
  }

  return input.mirrorExists && input.mirrorFresh
    ? { mode: "light", reason: "A managed mirror exists, but this pull request is not checked out yet." }
    : { mode: "light", reason: "No managed checkout exists for this pull request." };
}
