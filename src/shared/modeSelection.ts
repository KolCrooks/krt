import type { DataMode, PreferredDataMode } from "./schemas.js";

export interface ModeSelectionInput {
  preferredMode: PreferredDataMode;
  mirrorExists: boolean;
  mirrorFresh: boolean;
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
    return input.mirrorExists
      ? { mode: "managed", reason: "Managed mode was requested and a local mirror exists." }
      : { mode: "light", reason: "Managed mode was requested, but no local mirror exists yet." };
  }

  if (input.mirrorExists && input.mirrorFresh) {
    return { mode: "managed", reason: "A fresh managed mirror is available." };
  }

  return { mode: "light", reason: "No fresh local mirror is available; opening in Light/API mode." };
}
