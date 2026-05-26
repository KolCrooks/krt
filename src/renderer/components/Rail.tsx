import { Code2, GitPullRequestArrow, ListTree, Puzzle, Search, Settings } from "lucide-react";
import type { AppView, TabViewMode } from "../store/uiStore.js";
import { useActiveTab, useUiStore } from "../store/uiStore.js";

const prItems: Array<{ view: TabViewMode; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { view: "overview", label: "Overview", icon: GitPullRequestArrow },
  { view: "review", label: "Review", icon: ListTree },
  { view: "editor", label: "Editor", icon: Code2 }
];

export function Rail(): React.JSX.Element {
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const modal = useUiStore((state) => state.modal);
  const openModal = useUiStore((state) => state.openModal);
  const closeModal = useUiStore((state) => state.closeModal);
  const activeTab = useActiveTab();

  const handlePrModeClick = (mode: TabViewMode): void => {
    if (modal) {
      closeModal();
    }
    if (activeTab) {
      setTabViewMode(activeTab.key, mode);
    } else {
      setActiveView(mode);
    }
  };

  const handleSearchClick = (): void => {
    if (modal) {
      closeModal();
    }
    setActiveView("search");
  };

  const toggleModal = (name: "extensions" | "settings"): void => {
    if (modal === name) {
      closeModal();
    } else {
      openModal(name);
    }
  };

  return (
    <nav className="rail" aria-label="Primary">
      <RailButton active={activeView === "search" && !modal} label="Search" icon={Search} onClick={handleSearchClick} />
      <div className="rail-sep" />
      <div className={activeTab ? "rail-group" : "rail-group hidden"}>
        {prItems.map((item) => (
          <RailButton
            active={!modal && activeTab ? activeTab.viewMode === item.view : false}
            icon={item.icon}
            key={item.view}
            label={item.label}
            onClick={() => handlePrModeClick(item.view)}
          />
        ))}
      </div>
      <div className="rail-spacer" />
      <RailButton active={modal === "extensions"} label="Extensions" icon={Puzzle} onClick={() => toggleModal("extensions")} />
      <RailButton active={modal === "settings"} label="Settings" icon={Settings} onClick={() => toggleModal("settings")} />
    </nav>
  );
}

function RailButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={active ? "rail-btn active" : "rail-btn"}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={18} aria-hidden="true" />
      <span className="rail-tooltip" aria-hidden="true">{label}</span>
    </button>
  );
}
