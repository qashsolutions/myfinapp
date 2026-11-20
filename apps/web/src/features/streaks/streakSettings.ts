import { compareText } from "@stackd/rules/text";
import type { StackdDb } from "../../data/db.ts";
import type { PathStepId, StreakPause } from "../../engine/bridge.ts";

/**
 * Where streaks keep what the person chose (owner decision, November 19, 2026). All are synced
 * settings, so they travel only inside the encrypted backup, and go in the export.
 */
export const RESTS_KEY = "streaks.rests"; // {set_aside: [week Mondays], under_plan: [...], sorted: [...]}
export const PAUSES_KEY = "streaks.pauses"; // [{start, end | null}]
export const FRESH_SEEN_KEY = "streaks.fresh_seen"; // {<streak>: the missed week's Monday}
export const CELEBRATED_KEY = "streaks.celebrated"; // the Monday of the week last celebrated
export const PATH_LAYOUT_KEY = "path.layout"; // {order, skipped, names}
export const PATH_REACHED_KEY = "path.reached"; // {<step>: date}
export const MILESTONES_REACHED_KEY = "milestones.reached"; // {<milestone>: date}

export type WeeklyStreakId = "set_aside" | "under_plan" | "sorted";

export interface PathLayout {
  order: PathStepId[];
  skipped: PathStepId[];
  names: Partial<Record<PathStepId, string>>;
}

export const NAME_MAX = 40;

function stamp(now: Date): string {
  return now.toISOString();
}

async function put(db: StackdDb, key: string, value: unknown, now: Date): Promise<void> {
  await db.settings.put({ key, value, updated_at: stamp(now) });
}

export function readRests(value: unknown): Record<WeeklyStreakId, string[]> {
  const v = (value ?? {}) as Partial<Record<WeeklyStreakId, unknown>>;
  const list = (x: unknown) =>
    Array.isArray(x) ? x.filter((d): d is string => typeof d === "string") : [];
  return { set_aside: list(v.set_aside), under_plan: list(v.under_plan), sorted: list(v.sorted) };
}

export function readPauses(value: unknown): StreakPause[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (p): p is StreakPause =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as StreakPause).start === "string" &&
      ((p as StreakPause).end === null || typeof (p as StreakPause).end === "string"),
  );
}

export function readDates(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

export function readLayout(value: unknown): PathLayout {
  const v = (value ?? {}) as Partial<PathLayout>;
  return {
    order: Array.isArray(v.order) ? v.order : [],
    skipped: Array.isArray(v.skipped) ? v.skipped : [],
    names: typeof v.names === "object" && v.names !== null ? v.names : {},
  };
}

/** Turns the week just gone into a rest week for one streak. */
export async function takeRestWeek(
  db: StackdDb,
  streak: WeeklyStreakId,
  weekStart: string,
  now: Date = new Date(),
): Promise<void> {
  const rests = readRests((await db.settings.get(RESTS_KEY))?.value);
  if (!rests[streak].includes(weekStart)) rests[streak] = [...rests[streak], weekStart];
  await put(db, RESTS_KEY, rests, now);
}

/** "Start again this week": the missed week is acknowledged and the card reads as usual. */
export async function startAgain(
  db: StackdDb,
  streak: WeeklyStreakId,
  weekStart: string,
  now: Date = new Date(),
): Promise<void> {
  const seen = readDates((await db.settings.get(FRESH_SEEN_KEY))?.value);
  await put(db, FRESH_SEEN_KEY, { ...seen, [streak]: weekStart }, now);
}

/** Pause every weekly streak from today, or end the open pause yesterday. */
export async function setStreaksPaused(
  db: StackdDb,
  paused: boolean,
  today: string,
  yesterday: string,
  now: Date = new Date(),
): Promise<void> {
  const pauses = readPauses((await db.settings.get(PAUSES_KEY))?.value);
  const open = pauses.findIndex((p) => p.end === null);
  if (paused && open === -1) pauses.push({ start: today, end: null });
  if (!paused && open !== -1) {
    const start = pauses[open]?.start ?? today;
    // A pause started today and ended today leaves no paused day at all.
    if (compareText(start, today) >= 0) pauses.splice(open, 1);
    else pauses[open] = { start, end: yesterday };
  }
  await put(db, PAUSES_KEY, pauses, now);
}

export async function savePathLayout(
  db: StackdDb,
  layout: PathLayout,
  now: Date = new Date(),
): Promise<void> {
  await put(db, PATH_LAYOUT_KEY, layout, now);
}

/**
 * Adds newly reached ids with their day; never moves a date already kept. `first` is true when
 * nothing was kept before: the first reading stamps what is already true without a celebration.
 */
export async function stampReached(
  db: StackdDb,
  key: typeof PATH_REACHED_KEY | typeof MILESTONES_REACHED_KEY,
  ids: string[],
  day: string,
  now: Date = new Date(),
): Promise<{ added: string[]; first: boolean }> {
  return db.transaction("rw", db.settings, async () => {
    const row = await db.settings.get(key);
    const known = readDates(row?.value);
    const added = ids.filter((id) => !(id in known));
    if (added.length === 0 && row) return { added, first: false };
    for (const id of added) known[id] = day;
    await db.settings.put({ key, value: known, updated_at: stamp(now) });
    return { added, first: !row };
  });
}

export async function markCelebrated(
  db: StackdDb,
  weekStart: string,
  now: Date = new Date(),
): Promise<boolean> {
  return db.transaction("rw", db.settings, async () => {
    const row = await db.settings.get(CELEBRATED_KEY);
    if (row?.value === weekStart) return false;
    await db.settings.put({ key: CELEBRATED_KEY, value: weekStart, updated_at: stamp(now) });
    return true;
  });
}
