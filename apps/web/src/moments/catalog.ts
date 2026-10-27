/**
 * The one catalog of messages (services/rules/stackd_rules/config/moments.yaml, compiled to
 * @stackd/rules/moments): in-app toasts and card lines per event, Home's nudges and the push
 * titles. Nothing here decides *whether* something happened; callers emit an event with its
 * values and this file only turns it into words.
 *
 * Variants are picked deterministically from a seed (the event's own id), so the same moment
 * always reads the same and back-to-back moments vary. No randomness, no clock.
 */
import moments from "@stackd/rules/moments";

export type Sound = "kaching" | "chime" | "none";
export type Confetti = "none" | "small" | "big";
export type Once = "always" | "per_day" | "per_month";

export interface MomentEvent {
  when: string;
  vars: string[];
  push?: string;
  settings?: string;
  toast?: string[];
  card?: string[];
  effects?: { sound: Sound; confetti: Confetti };
  once?: Once;
  /** The toast's one link (October 23, 2026), e.g. to where the facts are. */
  action?: { label: string; to: string };
}

export interface Nudge {
  vars: string[];
  title: string;
  detail: string;
  cta: string;
  to: string;
}

interface Catalog {
  version: number;
  events: Record<string, MomentEvent>;
  push_summary: string;
  push_summary_one: string;
  nudges: Record<string, Nudge>;
}

export const CATALOG = moments as Catalog;

/** The in-app events the device emits (the catalog's events that have a toast or a card). */
export type MomentType =
  | "jar_deposit"
  | "income_logged"
  | "goal_reached"
  | "milestone_reached"
  | "debt_paid_down"
  | "checkin_done"
  | "spending_up"
  | "over_plan"
  | "card_paid"
  | "card_plan"
  | "card_no_payday"
  | "card_past_due"
  | "card_no_due_date";

export type Vars = Record<string, string>;

/** {name} → value. A placeholder with no value is left out rather than shown raw. */
export function fill(template: string, vars: Vars): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => vars[name] ?? "");
}

/** FNV-1a 32 over the seed: a stable index into a list of variants. */
export function pickIndex(seed: string, count: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return count > 0 ? h % count : 0;
}

export function eventOf(type: MomentType): MomentEvent {
  const ev = CATALOG.events[type];
  if (!ev) throw new Error(`moments: no event ${type}`);
  return ev;
}

export function toastText(type: MomentType, vars: Vars, seed: string): string | null {
  const lines = eventOf(type).toast;
  if (!lines?.length) return null;
  return fill(lines[pickIndex(seed, lines.length)] ?? lines[0] ?? "", vars);
}

export function cardText(type: MomentType, vars: Vars, seed: string): string | null {
  const lines = eventOf(type).card;
  if (!lines?.length) return null;
  return fill(lines[pickIndex(seed, lines.length)] ?? lines[0] ?? "", vars);
}

/** Home's next-move card: title, detail, call to action and destination with values filled in. */
export function nudgeCopy(id: string, vars: Vars = {}): Omit<Nudge, "vars"> {
  const n = CATALOG.nudges[id] ?? CATALOG.nudges.start_goal;
  if (!n) throw new Error("moments: no start_goal nudge");
  return {
    title: fill(n.title, vars),
    detail: fill(n.detail, vars),
    cta: fill(n.cta, vars),
    to: fill(n.to, vars),
  };
}

/** The title Me → Notifications shows for a push type. */
export function pushSettingsTitle(type: string): string {
  return CATALOG.events[type]?.settings ?? type;
}
