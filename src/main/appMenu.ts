import { Menu, app, type MenuItemConstructorOptions } from "electron";
import { openExternalUrl } from "./externalLinks.js";

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
      submenu: [process.platform === "darwin" ? { role: "close" } : { role: "quit" }]
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
