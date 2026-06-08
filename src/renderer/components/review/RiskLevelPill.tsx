import { useId } from "react";
import { Info } from "lucide-react";
import { relativeRiskClass } from "../../lib/format.js";
import type { RiskLevel } from "../../../shared/schemas.js";

const RISK_HELP: Record<RiskLevel, string> = {
  high: "High risk: inspect rigorously before approving; broad blast radius, sensitive contracts, failing checks, or hot-path behavior may be involved.",
  medium: "Medium risk: targeted verification is useful; the change is meaningful but contained.",
  low: "Low risk: small or localized change; still review normally, but broad regressions are less likely."
};

interface RiskLevelPillProps {
  level: RiskLevel;
}

export function RiskLevelPill({ level }: RiskLevelPillProps): React.JSX.Element {
  const helpId = useId();
  return (
    <span
      className={`${relativeRiskClass(level)} risk-with-help`}
      tabIndex={0}
      aria-describedby={helpId}
      aria-label={RISK_HELP[level]}
    >
      {level}
      <Info size={10} aria-hidden="true" />
      <span className="risk-help-tooltip" id={helpId} role="tooltip">
        {RISK_HELP[level]}
      </span>
    </span>
  );
}
