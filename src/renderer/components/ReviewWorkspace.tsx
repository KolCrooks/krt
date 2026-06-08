import { useState } from "react";
import { AiProcessingChip } from "./review/AiProcessingChip.js";
import { CheckoutBanner } from "./review/CheckoutBanner.js";
import { DiffReviewBody } from "./review/DiffReviewBody.js";
import { StoryboardBody } from "./review/StoryboardBody.js";
import { TourBody } from "./review/TourBody.js";
import { FinishReviewPopover } from "./FinishReviewPopover.js";
import { WorkspaceTabBar } from "./WorkspaceTabBar.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

interface ReviewWorkspaceProps {
  tab: PrTab;
  active?: boolean;
}

export function ReviewWorkspace({ tab, active = true }: ReviewWorkspaceProps): React.JSX.Element {
  const [layout, setLayout] = useState<"inline" | "split">("inline");
  const setFinishOpen = useUiStore((state) => state.setFinishOpen);

  return (
    <main className={`view review-workspace diff-layout-${layout}`}>
      <CheckoutBanner tab={tab} />
      <WorkspaceTabBar
        tab={tab}
        mode="review"
        active={active}
        layout={layout}
        onLayoutChange={setLayout}
        onFinishReview={() => setFinishOpen(tab.key, true)}
      />
      <div className={`review-body review-body-${tab.reviewSubMode}`}>
        {tab.reviewSubMode === "diff" ? <DiffReviewBody tab={tab} layout={layout} active={active} /> : null}
        {tab.reviewSubMode === "tour" ? <TourBody tab={tab} layout={layout} active={active} /> : null}
        {tab.reviewSubMode === "storyboard" ? <StoryboardBody tab={tab} layout={layout} active={active} /> : null}
      </div>
      <AiProcessingChip tab={tab} />
      {tab.finish.open ? <FinishReviewPopover tab={tab} onClose={() => setFinishOpen(tab.key, false)} /> : null}
    </main>
  );
}
