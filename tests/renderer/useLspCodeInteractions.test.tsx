import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLspCodeInteractions } from "../../src/renderer/hooks/useLspCodeInteractions.js";
import type { LspHover, RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const originalGetHover = window.krt.lsp.getHover;
const originalGetDefinition = window.krt.lsp.getDefinition;
type LspInteractionOptions = ReturnType<typeof useLspCodeInteractions>["options"];
type LspSurfaceProps = ReturnType<typeof useLspCodeInteractions>["surfaceProps"];

afterEach(() => {
  window.krt.lsp.getHover = originalGetHover;
  window.krt.lsp.getDefinition = originalGetDefinition;
  vi.useRealTimers();
});

describe("useLspCodeInteractions", () => {
  it("waits for hover content instead of rendering a transient loading card", async () => {
    vi.useFakeTimers();
    let resolveHover: (hover: LspHover) => void = () => undefined;
    window.krt.lsp.getHover = vi.fn(
      () =>
        new Promise<LspHover>((resolve) => {
          resolveHover = resolve;
        })
    );
    const capturedOptions: { current: LspInteractionOptions | null } = { current: null };

    render(<Harness onOptions={(nextOptions) => (capturedOptions.current = nextOptions)} />);

    expect(capturedOptions.current?.onTokenEnter).toBeDefined();
    const options = capturedOptions.current;
    if (!options?.onTokenEnter) {
      throw new Error("Expected LSP token enter handler");
    }
    const onTokenEnter = options.onTokenEnter;
    const tokenElement = document.createElement("span");
    act(() => {
      onTokenEnter(
        {
          lineNumber: 1,
          lineCharStart: 7,
          lineCharEnd: 13,
          tokenText: "symbol",
          tokenElement
        },
        { clientX: 80, clientY: 90 } as PointerEvent
      );
    });
    expect(tokenElement).toHaveAttribute("data-lsp-symbol-hovered");
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(window.krt.lsp.getHover).toHaveBeenCalledWith({
      repository,
      headSha: "abc123",
      path: "src/lib.rs",
      position: { line: 0, character: 7 }
    });
    expect(screen.queryByText("Loading")).not.toBeInTheDocument();

    await act(async () => {
      resolveHover({
        source: "rust-analyzer",
        path: "src/lib.rs",
        position: { line: 0, character: 7 },
        contents: "**String** hover"
      });
      await Promise.resolve();
    });

    expect(screen.getByText("symbol")).toBeInTheDocument();
    expect(screen.getByText("String")).toBeInTheDocument();
    expect(screen.getByText("rust-analyzer")).toBeInTheDocument();

    act(() => {
      options.onTokenLeave?.(
        {
          lineNumber: 1,
          lineCharStart: 7,
          lineCharEnd: 13,
          tokenText: "symbol",
          tokenElement
        },
        { clientX: 80, clientY: 90 } as PointerEvent
      );
      vi.advanceTimersByTime(260);
      vi.runOnlyPendingTimers();
    });
    expect(tokenElement).not.toHaveAttribute("data-lsp-symbol-hovered");
  });

  it("opens definitions with the one-based target line", async () => {
    window.krt.lsp.getDefinition = vi.fn(async () => ({
      source: "rust-analyzer",
      path: "src/main.rs",
      range: {
        start: { line: 41, character: 2 },
        end: { line: 41, character: 8 }
      }
    }));
    const onOpenDefinition = vi.fn();
    const capturedOptions: { current: LspInteractionOptions | null } = { current: null };

    render(<Harness onOptions={(nextOptions) => (capturedOptions.current = nextOptions)} onOpenDefinition={onOpenDefinition} />);

    const options = capturedOptions.current;
    if (!options?.onTokenClick) {
      throw new Error("Expected LSP token click handler");
    }
    const onTokenClick = options.onTokenClick;

    await act(async () => {
      onTokenClick(
        {
          lineNumber: 3,
          lineCharStart: 10,
          lineCharEnd: 16,
          tokenText: "symbol",
          tokenElement: document.createElement("span")
        },
        { metaKey: true, ctrlKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent
      );
      await Promise.resolve();
    });

    expect(window.krt.lsp.getDefinition).toHaveBeenCalledWith({
      repository,
      headSha: "abc123",
      path: "src/lib.rs",
      position: { line: 2, character: 10 }
    });
    expect(onOpenDefinition).toHaveBeenCalledWith("src/main.rs", 42);
  });

  it("uses a mouse-down capture fallback for command-clicked rendered tokens", async () => {
    window.krt.lsp.getDefinition = vi.fn(async () => ({
      source: "rust-analyzer",
      path: "src/definition.rs",
      range: {
        start: { line: 12, character: 0 },
        end: { line: 12, character: 6 }
      }
    }));
    const onOpenDefinition = vi.fn();
    const capturedSurfaceProps: { current: LspSurfaceProps | null } = { current: null };
    const token = document.createElement("span");
    token.dataset.char = "6";
    token.textContent = "target";
    const line = document.createElement("div");
    line.dataset.line = "9";
    line.dataset.lineType = "context";
    const code = document.createElement("code");
    code.dataset.code = "";
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const stopImmediatePropagation = vi.fn();

    render(
      <Harness
        onOptions={() => undefined}
        onSurfaceProps={(nextProps) => (capturedSurfaceProps.current = nextProps)}
        onOpenDefinition={onOpenDefinition}
      />
    );

    const onMouseDownCapture = capturedSurfaceProps.current?.onMouseDownCapture;
    if (!onMouseDownCapture) {
      throw new Error("Expected surface mouse-down capture handler");
    }

    await act(async () => {
      onMouseDownCapture({
        nativeEvent: {
          metaKey: true,
          ctrlKey: false,
          button: 0,
          composedPath: () => [token, line, code],
          stopImmediatePropagation
        },
        preventDefault,
        stopPropagation
      } as unknown as React.MouseEvent<HTMLElement>);
      await Promise.resolve();
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(stopImmediatePropagation).toHaveBeenCalled();
    expect(window.krt.lsp.getDefinition).toHaveBeenCalledWith({
      repository,
      headSha: "abc123",
      path: "src/lib.rs",
      position: { line: 8, character: 6 }
    });
    expect(onOpenDefinition).toHaveBeenCalledWith("src/definition.rs", 13);
  });

  it("deduplicates mouse-down and click definition handling for the same token", async () => {
    window.krt.lsp.getDefinition = vi.fn(async () => ({
      source: "rust-analyzer",
      path: "src/definition.rs",
      range: {
        start: { line: 12, character: 0 },
        end: { line: 12, character: 6 }
      }
    }));
    const capturedSurfaceProps: { current: LspSurfaceProps | null } = { current: null };
    const token = document.createElement("span");
    token.dataset.char = "6";
    token.textContent = "target";
    const line = document.createElement("div");
    line.dataset.line = "9";
    line.dataset.lineType = "context";
    const code = document.createElement("code");
    code.dataset.code = "";

    render(
      <Harness
        onOptions={() => undefined}
        onSurfaceProps={(nextProps) => (capturedSurfaceProps.current = nextProps)}
      />
    );

    const onMouseDownCapture = capturedSurfaceProps.current?.onMouseDownCapture;
    const onClickCapture = capturedSurfaceProps.current?.onClickCapture;
    if (!onMouseDownCapture || !onClickCapture) {
      throw new Error("Expected surface capture handlers");
    }

    const event = {
      nativeEvent: {
        metaKey: true,
        ctrlKey: false,
        button: 0,
        composedPath: () => [token, line, code],
        stopImmediatePropagation: vi.fn()
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as React.MouseEvent<HTMLElement>;

    await act(async () => {
      onMouseDownCapture(event);
      onClickCapture(event);
      await Promise.resolve();
    });

    expect(window.krt.lsp.getDefinition).toHaveBeenCalledTimes(1);
  });
});

interface HarnessProps {
  onOptions: (options: LspInteractionOptions) => void;
  onSurfaceProps?: (surfaceProps: LspSurfaceProps) => void;
  onOpenDefinition?: (path: string, line: number) => void;
}

function Harness({ onOptions, onSurfaceProps, onOpenDefinition }: HarnessProps): React.JSX.Element {
  const interactions = useLspCodeInteractions({
    enabled: true,
    repository,
    headSha: "abc123",
    path: "src/lib.rs",
    onOpenDefinition
  });

  onOptions(interactions.options);
  onSurfaceProps?.(interactions.surfaceProps);

  return <div>{interactions.hoverCard}</div>;
}
