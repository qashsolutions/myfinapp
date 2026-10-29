import type { SafeToSpend } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";

/**
 * The window in plain words, matching the rule's (invariant 53): through the next pay period
 * when two paydays are known, until payday with one, else the forecast's days.
 */
export function safeWindowText(s: SafeToSpend): string {
  if (s.window === "pay_period" && s.payday)
    return `through your next pay period (to ${formatDay(s.payday)})`;
  if (s.window === "payday" && s.payday) return `until payday (${formatDay(s.payday)})`;
  return `over the next ${s.days} ${s.days === 1 ? "day" : "days"}`;
}

/** "Safe to spend through your next pay period (to Nov 14): $412, about $29 a day". */
export function safeToSpendText(s: SafeToSpend): string {
  const window = safeWindowText(s);
  if (s.safe_cents === 0)
    return `Nothing extra is safe to spend ${window}; your cushion is the limit`;
  return `Safe to spend ${window}: ${formatCents(s.safe_cents)}, about ${formatCents(s.per_day_cents)} a day`;
}

export function SafeToSpendLine({ value }: { value: SafeToSpend | null }) {
  if (!value) return null;
  return (
    <p className="insight__safe" role="status">
      {safeToSpendText(value)}
      <span className="insight__fine"> · after your usual spending. An estimate.</span>
    </p>
  );
}
