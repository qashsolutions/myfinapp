/** Display formatting for money and dates. Rules never format; this is the only place that does. */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 4217 → "$42.17". With `direction`, "+$42.17" or "−$42.17" (a real minus sign). */
export function formatCents(cents: number, direction?: "in" | "out"): string {
  const abs = usd.format(Math.abs(cents) / 100);
  if (direction === "in") return `+${abs}`;
  if (direction === "out") return `−${abs}`;
  return cents < 0 ? `−${abs}` : abs;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

/** "2026-10" or "2026-10-09" → "October 2026". */
export function formatMonth(iso: string): string {
  const [y, m] = parts(iso);
  return `${MONTHS[m - 1]} ${y}`;
}

/** "2029-03" or "2029-03-01" → "Mar 2029" (a date shown as a card's value). */
export function formatMonthShort(iso: string): string {
  const [y, m] = parts(iso);
  return `${SHORT[m - 1]} ${y}`;
}

/** "$120" when the cents add nothing, else "$120.50" (short lines that compare two amounts). */
export function formatCentsTidy(cents: number): string {
  return formatCents(cents).replace(/\.00$/, "");
}

/** "2026-10-09" → "Oct 9", with the year when it is not `now`'s. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const [y, m, d] = parts(iso);
  return y === now.getFullYear() ? `${SHORT[m - 1]} ${d}` : `${SHORT[m - 1]} ${d}, ${y}`;
}

/** "2027-10-09" or an ISO datetime → "Oct 9, 2027" (always with the year; renewal and term dates). */
export function formatDate(iso: string): string {
  if (iso.length > 10) {
    const d = new Date(iso);
    return `${SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  const [y, m, d] = parts(iso);
  return `${SHORT[m - 1]} ${d}, ${y}`;
}

/** The user's local calendar date as YYYY-MM-DD (never UTC, which can be tomorrow or yesterday). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole dollars, rounded down, for headline savings ("Save $233"); never for amounts owed. */
export function formatWholeDollars(cents: number): string {
  return usd.format(Math.floor(Math.abs(cents) / 100)).replace(/\.00$/, "");
}
