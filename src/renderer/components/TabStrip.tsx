import { Search, X } from "lucide-react";
import { krtClient } from "../api/client.js";
import type { TabViewMode } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";

export function TabStrip(): React.JSX.Element {
  const tabs = useUiStore((state) => state.tabs);
  const activeTabKey = useUiStore((state) => state.activeTabKey);
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const selectTab = useUiStore((state) => state.selectTab);
  const closeTab = useUiStore((state) => state.closeTab);

  return (
    <div className="tabstrip tabbar" role="tablist" aria-label="Open pull requests">
      <button
        className={activeView === "search" ? "tab-search active" : "tab-search"}
        type="button"
        aria-label="Search pull requests"
        onClick={() => setActiveView("search")}
      >
        <Search size={14} aria-hidden="true" />
        <span>Search</span>
        <span className="kbd" aria-hidden="true">Cmd K</span>
      </button>
      {tabs.map((tab) => (
        <div
          className={activeTabKey === tab.key && activeView !== "search" ? "tab active is-active" : "tab"}
          key={tab.key}
        >
          <button
            className="tab-main"
            role="tab"
            aria-selected={activeTabKey === tab.key}
            type="button"
            onClick={() => {
              selectTab(tab.key);
            }}
          >
            <span className={`modedot ${modeDotClass(tab.viewMode)}`} aria-hidden="true" />
            <span className="num tab-number">#{tab.number}</span>
            <span className="ttl tab-title">{tab.title}</span>
          </button>
          <button
            type="button"
            className="tab-close x"
            aria-label={`Close ${tab.repository} #${tab.number}`}
            onClick={() => {
              if (tab.mode === "managed") {
                void krtClient.repos.releaseWorktree({
                  repository: tab.bundle.detail.repository,
                  headSha: tab.bundle.detail.headSha
                });
              }
              closeTab(tab.key);
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <span className="tab-fill" aria-hidden="true" />
    </div>
  );
}

function modeDotClass(viewMode: TabViewMode): string {
  switch (viewMode) {
    case "review":
      return "review";
    case "editor":
      return "editor";
    case "overview":
      return "";
  }
}
