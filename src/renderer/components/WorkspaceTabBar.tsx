import {
  CheckCircle2,
  Columns2,
  FileText,
  GitPullRequestArrow,
  ListTree,
  Sparkles,
  SplitSquareHorizontal,
  Waypoints,
  X
} from "lucide-react";
import type { PrTab, ReviewSubMode, TabViewMode } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

type DiffLayout = "inline" | "split";

interface WorkspaceTabBarProps {
  tab: PrTab;
  mode: TabViewMode;
  layout?: DiffLayout;
  onLayoutChange?: (layout: DiffLayout) => void;
  onFinishReview: () => void;
}

export function WorkspaceTabBar({
  tab,
  mode,
  layout = "inline",
  onLayoutChange,
  onFinishReview
}: WorkspaceTabBarProps): React.JSX.Element {
  const closeFile = useUiStore((state) => state.closeFile);
  const selectFile = useUiStore((state) => state.selectFile);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const setReviewSubMode = useUiStore((state) => state.setReviewSubMode);

  const isReviewMode = mode === "review";
  const reviewPillClass = isReviewMode ? "rev-tab rev-tab-review active" : "rev-tab rev-tab-review";

  return (
    <div className="rev-tabstrip">
      <button
        className={reviewPillClass}
        type="button"
        onClick={() => setTabViewMode(tab.key, "review")}
      >
        <GitPullRequestArrow size={13} aria-hidden="true" />
        <span>Review</span>
      </button>
      {tab.openFilePaths.map((path) => {
        const isActive = !isReviewMode && path === tab.selectedFilePath;
        return (
          <div className={isActive ? "rev-tab rev-tab-file is-file-active" : "rev-tab rev-tab-file"} key={path} title={path}>
            <button
              className="rev-tab-main"
              type="button"
              onClick={() => {
                selectFile(tab.key, path);
                setTabViewMode(tab.key, "editor");
              }}
            >
              <FileText size={12} aria-hidden="true" />
              <span className="mono">{path.split("/").at(-1)}</span>
            </button>
            <button
              className="rev-tab-x"
              type="button"
              aria-label={`Close ${path}`}
              onClick={(event) => {
                event.stopPropagation();
                closeFile(tab.key, path);
              }}
            >
              <X size={9} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      <span className="rev-tab-fill" aria-hidden="true" />
      <div className="rev-actions">
        <LspChip tab={tab} />
        {isReviewMode && onLayoutChange ? (
          <div className="rev-controls">
            <div className="segmented compact" aria-label="Review mode">
              <SubModeButton tab={tab} subMode="diff" label="Diff" icon={ListTree} onSelect={setReviewSubMode} />
              <SubModeButton tab={tab} subMode="tour" label="Tour" icon={Sparkles} onSelect={setReviewSubMode} />
              <SubModeButton tab={tab} subMode="storyboard" label="Storyboard" icon={Waypoints} onSelect={setReviewSubMode} />
            </div>
            <div className="segmented compact" aria-label="Diff layout">
              <button type="button" title="Inline diff" className={layout === "inline" ? "is-active" : ""} onClick={() => onLayoutChange("inline")}>
                <Columns2 size={13} aria-hidden="true" />
              </button>
              <button type="button" title="Split diff" className={layout === "split" ? "is-active" : ""} onClick={() => onLayoutChange("split")}>
                <SplitSquareHorizontal size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
        <button className="primary-button finish-review-button" type="button" onClick={onFinishReview}>
          <CheckCircle2 size={13} aria-hidden="true" />
          Finish review
        </button>
      </div>
    </div>
  );
}

interface SubModeButtonProps {
  tab: PrTab;
  subMode: ReviewSubMode;
  label: string;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  onSelect: (tabKey: string, subMode: ReviewSubMode) => void;
}

function SubModeButton({ tab, subMode, label, icon: Icon, onSelect }: SubModeButtonProps): React.JSX.Element {
  const active = tab.reviewSubMode === subMode;
  return (
    <button type="button" className={active ? "is-active" : ""} onClick={() => onSelect(tab.key, subMode)}>
      <Icon size={13} aria-hidden={true} />
      {label}
    </button>
  );
}

interface LspChipProps {
  tab: PrTab;
}

function LspChip({ tab }: LspChipProps): React.JSX.Element {
  const isChecked = tab.checkout.state === "checked" || tab.mode === "managed";
  const isChecking = tab.checkout.state === "checking";
  if (isChecked) {
    return (
      <span className="lsp-chip is-on" title="LSP active for this branch">
        <span className="lsp-chip-dot" />
        LSP
      </span>
    );
  }
  if (isChecking) {
    return (
      <span className="lsp-chip is-loading">
        <span className="lsp-chip-dot" />
        LSP…
      </span>
    );
  }
  return (
    <span className="lsp-chip" title="Check out branch to enable LSP">
      <span className="lsp-chip-dot" />
      LSP off
    </span>
  );
}
