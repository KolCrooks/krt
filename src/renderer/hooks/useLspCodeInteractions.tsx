import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { krtClient } from "../api/client.js";
import { isDefinitionGesture, targetFromLspToken, tokenPointerFromComposedPath, type LspTokenPointer, type LspTokenTarget } from "../lib/lspTokens.js";
import { renderMarkdown } from "../lib/markdown.js";
import type { LspDefinition, LspHover, RepositoryRef } from "../../shared/schemas.js";

interface LspCodeInteractionsConfig {
  enabled: boolean;
  repository: RepositoryRef;
  headSha: string;
  path: string | null;
  onOpenDefinition?: (path: string, line: number) => void;
}

interface HoverAnchor {
  x: number;
  y: number;
}

interface HoverState {
  anchor: HoverAnchor;
  target: LspTokenTarget;
  status: "loading" | "ready" | "error";
  hover: LspHover | null;
  definition: LspDefinition | null;
  definitionStatus: "idle" | "loading" | "ready" | "empty" | "error";
}

export function useLspCodeInteractions({
  enabled,
  repository,
  headSha,
  path,
  onOpenDefinition
}: LspCodeInteractionsConfig): {
  options: {
    useTokenTransformer?: boolean;
    lineHoverHighlight?: "line";
    onTokenEnter?: (token: LspTokenPointer, event: PointerEvent) => void;
    onTokenLeave?: (token: LspTokenPointer, event: PointerEvent) => void;
    onTokenClick?: (token: LspTokenPointer, event: MouseEvent) => void;
  };
  surfaceProps: {
    onClickCapture?: (event: ReactMouseEvent<HTMLElement>) => void;
    onMouseDownCapture?: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  hoverCard: React.JSX.Element | null;
} {
  const [hoverState, setHoverState] = useState<HoverState | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const requestId = useRef(0);
  const activeTarget = useRef<LspTokenTarget | null>(null);
  const highlightedTokenElement = useRef<HTMLElement | null>(null);
  const lastDefinitionRequest = useRef<{ key: string; requestedAt: number } | null>(null);
  const currentPath = path ?? "";

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const clearHighlightedToken = useCallback(() => {
    highlightedTokenElement.current?.removeAttribute("data-lsp-symbol-hovered");
    highlightedTokenElement.current = null;
  }, []);

  const highlightToken = useCallback(
    (token: LspTokenPointer) => {
      const element = token.tokenElement;
      if (!element || highlightedTokenElement.current === element) {
        return;
      }
      clearHighlightedToken();
      element.setAttribute("data-lsp-symbol-hovered", "");
      highlightedTokenElement.current = element;
    },
    [clearHighlightedToken]
  );

  const hideHover = useCallback(() => {
    clearHoverTimer();
    clearHideTimer();
    clearHighlightedToken();
    activeTarget.current = null;
    requestId.current += 1;
    setHoverState(null);
  }, [clearHideTimer, clearHoverTimer, clearHighlightedToken]);

  const scheduleHideHover = useCallback(() => {
    clearHideTimer();
    hideTimer.current = window.setTimeout(hideHover, 420);
  }, [clearHideTimer, hideHover]);

  const requestHover = useCallback(
    async (target: LspTokenTarget, anchor: HoverAnchor) => {
      const id = requestId.current + 1;
      requestId.current = id;

      let loadingTimer: number | null = window.setTimeout(() => {
        loadingTimer = null;
        if (requestId.current !== id || activeTarget.current?.key !== target.key) {
          return;
        }
        setHoverState((prev) =>
          prev?.target.key === target.key
            ? prev
            : {
                anchor,
                target,
                status: "loading",
                hover: null,
                definition: null,
                definitionStatus: "idle"
              }
        );
      }, 140);
      const clearLoadingTimer = (): void => {
        if (loadingTimer !== null) {
          window.clearTimeout(loadingTimer);
          loadingTimer = null;
        }
      };

      try {
        const hover = await krtClient.lsp.getHover({
          repository,
          headSha,
          path: currentPath,
          position: target.position
        });
        clearLoadingTimer();
        if (requestId.current !== id || activeTarget.current?.key !== target.key) {
          return;
        }
        if (!hover) {
          setHoverState(null);
          return;
        }
        setHoverState({
          anchor,
          target,
          status: "ready",
          hover,
          definition: null,
          definitionStatus: "idle"
        });
      } catch {
        clearLoadingTimer();
        if (requestId.current === id && activeTarget.current?.key === target.key) {
          setHoverState({
            anchor,
            target,
            status: "error",
            hover: null,
            definition: null,
            definitionStatus: "idle"
          });
        }
      }
    },
    [currentPath, headSha, repository]
  );

  const requestDefinition = useCallback(
    async (target: LspTokenTarget) => {
      if (!enabled || !currentPath) {
        return;
      }
      const now = performance.now();
      if (lastDefinitionRequest.current?.key === target.key && now - lastDefinitionRequest.current.requestedAt < 600) {
        return;
      }
      lastDefinitionRequest.current = { key: target.key, requestedAt: now };
      setHoverState((prev) =>
        prev?.target.key === target.key ? { ...prev, definitionStatus: "loading" } : prev
      );

      try {
        const definition = await krtClient.lsp.getDefinition({
          repository,
          headSha,
          path: currentPath,
          position: target.position
        });
        setHoverState((prev) =>
          prev?.target.key === target.key
            ? {
                ...prev,
                definition,
                definitionStatus: definition ? "ready" : "empty"
              }
            : prev
        );
        if (definition) {
          onOpenDefinition?.(definition.path, definition.range.start.line + 1);
        }
      } catch {
        setHoverState((prev) =>
          prev?.target.key === target.key ? { ...prev, definitionStatus: "error" } : prev
        );
      }
    },
    [currentPath, enabled, headSha, onOpenDefinition, repository]
  );

  const handleTokenEnter = useCallback(
    (token: LspTokenPointer, event: PointerEvent) => {
      if (!enabled || !currentPath) {
        return;
      }
      const target = targetFromLspToken(currentPath, token);
      if (!target) {
        clearHighlightedToken();
        return;
      }
      clearHideTimer();
      clearHoverTimer();
      highlightToken(token);
      activeTarget.current = target;
      setHoverState((prev) => (prev?.target.key === target.key ? prev : null));
      const anchor = hoverAnchorFromEvent(event);
      hoverTimer.current = window.setTimeout(() => {
        if (activeTarget.current?.key !== target.key) {
          return;
        }
        void requestHover(target, anchor);
      }, 60);
    },
    [clearHideTimer, clearHoverTimer, clearHighlightedToken, currentPath, enabled, highlightToken, requestHover]
  );

  const handleTokenLeave = useCallback(() => {
    scheduleHideHover();
  }, [scheduleHideHover]);

  const handleTokenClick = useCallback(
    (token: LspTokenPointer, event: MouseEvent) => {
      if (!enabled || !currentPath || !isDefinitionGesture(event)) {
        return;
      }
      const target = targetFromLspToken(currentPath, token);
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activeTarget.current = target;
      void requestDefinition(target);
    },
    [currentPath, enabled, requestDefinition]
  );

  const handleSurfaceDefinitionGestureCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const nativeEvent = event.nativeEvent;
      if (!enabled || !currentPath || nativeEvent.button !== 0 || !isDefinitionGesture(nativeEvent)) {
        return;
      }
      const token = tokenPointerFromComposedPath(nativeEvent.composedPath());
      const target = token ? targetFromLspToken(currentPath, token) : null;
      if (!token || !target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      nativeEvent.stopImmediatePropagation();
      highlightToken(token);
      activeTarget.current = target;
      void requestDefinition(target);
    },
    [currentPath, enabled, highlightToken, requestDefinition]
  );

  useEffect(
    () => () => {
      clearHoverTimer();
      clearHideTimer();
      clearHighlightedToken();
    },
    [clearHideTimer, clearHoverTimer, clearHighlightedToken]
  );

  useEffect(() => {
    if (!enabled) {
      hideHover();
    }
  }, [enabled, hideHover]);

  useEffect(() => {
    hideHover();
  }, [currentPath, headSha, hideHover]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const setActive = (active: boolean): void => {
      document.documentElement.classList.toggle("lsp-modifier-active", active);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) {
        setActive(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!event.metaKey && !event.ctrlKey) {
        setActive(false);
      }
    };
    const onBlur = (): void => setActive(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      setActive(false);
    };
  }, [enabled]);

  const popoverRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!hoverState || !el) {
      return;
    }
    const PAD = 12;
    const OFFSET_X = 14;
    const OFFSET_Y = 16;
    const rect = el.getBoundingClientRect();
    const cursorX = hoverState.anchor.x;
    const cursorY = hoverState.anchor.y;
    let x = cursorX + OFFSET_X;
    let y = cursorY + OFFSET_Y;
    if (x + rect.width > window.innerWidth - PAD) {
      x = cursorX - OFFSET_X - rect.width;
    }
    x = Math.max(PAD, Math.min(x, window.innerWidth - rect.width - PAD));
    if (y + rect.height > window.innerHeight - PAD) {
      y = cursorY - OFFSET_Y - rect.height;
    }
    y = Math.max(PAD, Math.min(y, window.innerHeight - rect.height - PAD));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [hoverState]);

  const hoverCard = hoverState ? (
    <div
      ref={popoverRef}
      className="lsp-hover-popover"
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHideHover}
      style={{ left: hoverState.anchor.x, top: hoverState.anchor.y }}
    >
      <div className="lsp-hover-header">
        <span className="lsp-hover-token">{hoverState.target.tokenText}</span>
        {hoverState.hover ? <span className="lsp-hover-source">{hoverState.hover.source}</span> : null}
      </div>
      {hoverState.status === "loading" ? (
        <div className="lsp-hover-skeleton" aria-label="Loading hover info">
          <span className="skeleton skeleton-line skeleton-line-wide" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line skeleton-line-narrow" />
        </div>
      ) : null}
      {hoverState.status === "error" ? <div className="lsp-hover-status">Unavailable</div> : null}
      {hoverState.hover ? (
        <div
          className="lsp-hover-description markdown compact"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(hoverState.hover.contents) }}
        />
      ) : null}
    </div>
  ) : null;

  const options = useMemo(
    () =>
      enabled
        ? {
            useTokenTransformer: true,
            lineHoverHighlight: "line" as const,
            onTokenEnter: handleTokenEnter,
            onTokenLeave: handleTokenLeave,
            onTokenClick: handleTokenClick
          }
        : {},
    [enabled, handleTokenClick, handleTokenEnter, handleTokenLeave]
  );
  const surfaceProps = useMemo(
    () =>
      enabled
        ? {
            onClickCapture: handleSurfaceDefinitionGestureCapture,
            onMouseDownCapture: handleSurfaceDefinitionGestureCapture
          }
        : {},
    [enabled, handleSurfaceDefinitionGestureCapture]
  );

  return { options, surfaceProps, hoverCard };
}

function hoverAnchorFromEvent(event: PointerEvent): HoverAnchor {
  return {
    x: event.clientX,
    y: event.clientY
  };
}
