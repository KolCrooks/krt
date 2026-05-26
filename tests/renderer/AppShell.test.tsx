import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "../../src/renderer/components/AppShell.js";

describe("AppShell", () => {
  it("renders the review workspace shell at the search surface", async () => {
    render(<AppShell />);

    expect(screen.getByLabelText("Current workspace")).toHaveTextContent("Kol's Review");
    expect(screen.getByLabelText("Pull request search")).toBeInTheDocument();
    expect(await screen.findByLabelText("Pull request results")).toBeInTheDocument();
  });

  it("applies persisted appearance settings to the document root", async () => {
    render(<AppShell />);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
      expect(document.documentElement).toHaveAttribute("data-density", "compact");
    });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#4f46e5");
  });
});
