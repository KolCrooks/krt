export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value > 9_999 ? "compact" : "standard" }).format(value);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function relativeRiskClass(risk: "low" | "medium" | "high"): string {
  return `risk risk-${risk}`;
}

export function statusClass(status: string): string {
  return `status-pill status-${status.replaceAll("_", "-")}`;
}
