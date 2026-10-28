import type { SafeToSpend } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";

/** "Safe to spend until Oct 24: $412 (about $29 a day)". Plain words, an estimate, not advice. */
export function safeToSpendText(s: SafeToSpend & { payday: string | null }): string {
  const window = s.payday ? `until payday (${formatDay(s.payday)})` : "over the next 30 days";
  if (s.safe_cents === 0)
    return `Nothing extra is safe to spend ${window}; your cushion is the limit`;
  return `Safe to spend ${window}: ${formatCents(s.safe_cents)}, about ${formatCents(s.per_day_cents)} a day`;
}

export function SafeToSpendLine({
  value,
}: {
  value: (SafeToSpend & { payday: string | null }) | null;
}) {
  if (!value) return null;
  return (
    <p className="insight__safe" role="status">
      {safeToSpendText(value)}
      <span className="insight__fine"> · after your usual spending. An estimate.</span>
    </p>
  );
}
