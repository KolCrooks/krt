// @vitest-environment node
import { Menu } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createApplicationMenuTemplate, installApplicationMenu } from "../../src/main/appMenu.js";
import { closeSubTabEvent } from "../../src/shared/ipc.js";

vi.mock("electron", () => ({
  app: { name: "KRT" },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null)
  },
  Menu: {
    buildFromTemplate: vi.fn((template) => ({ template })),
    setApplicationMenu: vi.fn()
  },
  shell: {
    openExternal: vi.fn(async () => undefined)
  }
}));

describe("application menu", () => {
  it("defines desktop menu groups for core app commands", () => {
    const template = createApplicationMenuTemplate();
    const labels = template.map((item) => item.label);

    expect(labels).toEqual(expect.arrayContaining(["File", "Edit", "View", "Window", "Help"]));
    expect(template.find((item) => item.label === "Help")?.submenu).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "GitHub" })])
    );
  });

  it("routes Cmd+W to the renderer file sub-tab close command", () => {
    const template = createApplicationMenuTemplate();
    const fileSubmenu = getSubmenu(template, "File");
    const closeItem = fileSubmenu.find((item) => item.label === "Close File Tab");

    expect(fileSubmenu).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Close File Tab", accelerator: "CommandOrControl+W" })])
    );
    expect(fileSubmenu).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "close" })]));
    expect(closeItem).toBeDefined();

    const send = vi.fn();
    const click = closeItem?.click;
    if (!click) {
      throw new Error("Close File Tab menu item is missing a click handler.");
    }

    click(
      {} as Parameters<typeof click>[0],
      { webContents: { send } } as unknown as Parameters<typeof click>[1],
      {} as Parameters<typeof click>[2]
    );

    expect(send).toHaveBeenCalledWith(closeSubTabEvent);
  });

  it("installs the built menu template", () => {
    installApplicationMenu();

    expect(Menu.buildFromTemplate).toHaveBeenCalledOnce();
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(expect.objectContaining({ template: expect.any(Array) }));
  });
});

function getSubmenu(template: ReturnType<typeof createApplicationMenuTemplate>, label: string) {
  const submenu = template.find((item) => item.label === label)?.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error(`Expected ${label} submenu.`);
  }
  return submenu;
}
