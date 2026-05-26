import { BrowserWindow, Menu, app, type MenuItemConstructorOptions } from "electron";
import { openExternalUrl } from "./externalLinks.js";
import { closeSubTabEvent } from "../shared/ipc.js";

export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate()));
}

export function createApplicationMenuTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }

  template.push(
    {
      label: "File",
      submenu: createFileMenu()
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(process.platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const }] : [])]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "GitHub",
          click: () => {
            void openExternalUrl("https://github.com/");
          }
        }
      ]
    }
  );

  return template;
}

function createFileMenu(): MenuItemConstructorOptions[] {
  const submenu: MenuItemConstructorOptions[] = [
    {
      label: "Close File Tab",
      accelerator: "CommandOrControl+W",
      click: (_item, focusedWindow) => {
        getCloseTargetWindow(focusedWindow)?.webContents.send(closeSubTabEvent);
      }
    }
  ];

  if (process.platform !== "darwin") {
    submenu.push({ type: "separator" }, { role: "quit" });
  }

  return submenu;
}

function getCloseTargetWindow(focusedWindow: unknown): Pick<BrowserWindow, "webContents"> | null {
  if (hasWebContents(focusedWindow)) {
    return focusedWindow;
  }
  return BrowserWindow.getFocusedWindow();
}

function hasWebContents(candidate: unknown): candidate is Pick<BrowserWindow, "webContents"> {
  return candidate !== null && typeof candidate === "object" && "webContents" in candidate;
}
