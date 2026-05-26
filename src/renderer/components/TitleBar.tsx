import { GitBranch } from "lucide-react";
import { useActiveTab } from "../store/uiStore.js";

export function TitleBar(): React.JSX.Element {
  const activeTab = useActiveTab();
  const detail = activeTab?.bundle.detail;

  return (
    <header className="titlebar">
      <div className="titlebar-center" aria-label="Current workspace">
        <span className="repo">{detail?.repository.fullName ?? "Kol's Review"}</span>
        {detail ? (
          <>
            <span className="titlebar-dot" aria-hidden="true">·</span>
            <span className="branch">
              <GitBranch size={10} aria-hidden="true" />
              {detail.headRef || detail.headSha.slice(0, 7)}
            </span>
          </>
        ) : null}
      </div>
    </header>
  );
}
