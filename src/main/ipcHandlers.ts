import { ipcMain } from "electron";
import { ipcContract, type IpcChannel } from "../shared/ipc.js";
import { createIpcExecutor, type IpcExecutor, type IpcHandlerContext } from "./ipcExecutor.js";

export type { IpcHandlerContext } from "./ipcExecutor.js";

const registeredChannels = new Set<IpcChannel>();
let currentExecutor: IpcExecutor | null = null;

export function registerIpcHandlers(context: IpcHandlerContext): void {
  currentExecutor = createIpcExecutor(context);

  for (const channel of Object.keys(ipcContract) as IpcChannel[]) {
    if (registeredChannels.has(channel)) {
      continue;
    }

    ipcMain.handle(channel, (event, rawInput) => {
      if (!currentExecutor) {
        return {
          ok: false,
          error: {
            code: "ipc_not_ready",
            message: "IPC handlers are not ready.",
            retryable: true
          }
        };
      }

      return currentExecutor(channel, event, rawInput);
    });
    registeredChannels.add(channel);
  }
}
