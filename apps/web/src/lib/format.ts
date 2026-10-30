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

/** "2026-10-01" → "Oct" (a chart's month label). */
export function formatMonthAbbr(iso: string): string {
  const [, m] = parts(iso);
  return SHORT[m - 1] ?? "";
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

/** An ISO datetime → "Oct 31, 2026 at 3:05 PM", in this device's time. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatDate(iso)} at ${h}:${mm} ${d.getHours() < 12 ? "AM" : "PM"}`;
}

/** The user's local calendar date as YYYY-MM-DD (never UTC, which can be tomorrow or yesterday). */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * How long ago a moment was, for "synced …": "just now", "5 min ago", "3 hr ago", "yesterday",
 * else the day ("Oct 9"). A moment in the future (another device's clock) reads as just now.
 */
export function formatSince(at: string, now: Date = new Date()): string {
  const then = new Date(at);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hr ago`;
  const day = todayIso(then);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day === todayIso(yesterday)) return "yesterday";
  return formatDay(day, now);
}

/** Whole dollars, rounded down, for headline savings ("Save $233"); never for amounts owed. */
export function formatWholeDollars(cents: number): string {
  return usd.format(Math.floor(Math.abs(cents) / 100)).replace(/\.00$/, "");
}
