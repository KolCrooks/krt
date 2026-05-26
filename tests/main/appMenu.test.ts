// @vitest-environment node
import { Menu } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createApplicationMenuTemplate, installApplicationMenu } from "../../src/main/appMenu.js";

vi.mock("electron", () => ({
  app: { name: "KRT" },
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

  it("installs the built menu template", () => {
    installApplicationMenu();

    expect(Menu.buildFromTemplate).toHaveBeenCalledOnce();
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(expect.objectContaining({ template: expect.any(Array) }));
  });
});
