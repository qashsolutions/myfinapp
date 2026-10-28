/**
 * What the current plan allows (docs/spec.md "Plans & billing"). The server derives it from
 * `plans.yaml` and answers `GET /api/billing/entitlements`; this device keeps the last answer so
 * the caps still apply offline. Until the server has answered once, Free's limits apply.
 */

import { useEffect, useSyncExternalStore } from "react";
import { api, failureOf } from "../../data/api.ts";
import { useSession } from "../auth/useSession.tsx";

export type PlanName = "free" | "private" | "connected" | "founding";

/**
 * Where this account stands (owner decision, October 14, 2026: trials, no lasting Free plan).
 * choose: pick a trial · trial: on it until `trial_ends_at` (a card is asked for from
 * `card_from`) · subscribed · lapsed: subscribe or export until `delete_at`, then deleted ·
 * paused: a payment is disputed with the bank, the plan stops until it's closed, never deleted ·
 * ended: a dispute was lost; the plan is over, no plan can be bought again on this account, and
 * the account stays open, never closed for it (owner decision, October 25, 2026).
 */
export interface Access {
  state: "choose" | "trial" | "subscribed" | "lapsed" | "paused" | "ended";
  plan: PlanName;
  trial_ends_at: string | null;
  /** The trial's full length in days (plans.yaml). */
  days: number | null;
  card_from: string | null;
  delete_at: string | null;
  /** choose only: this inbox already had its free trial (signing up again), so only buying is left. */
  trial_used: boolean;
}

export interface Entitlements {
  plan: PlanName;
  /** null until the server has said (a cached answer from before trials has none). */
  access: Access | null;
  /** Jars and goals of any kind, finished ones too; a challenge membership counts as one. null = unlimited. */
  goals_active_max: number | null;
  statement_accounts_max: number | null;
  groups_create: boolean;
  groups_join_max: number | null;
  bank_links_max: number | null;
  backup: boolean;
  household: boolean;
}

/** Free's limits, the fallback before the first server answer. A test checks them against plans.yaml. */
export const FREE_ENTITLEMENTS: Entitlements = {
  plan: "free",
  access: null,
  goals_active_max: 2,
  statement_accounts_max: 1,
  groups_create: false,
  groups_join_max: 1,
  bank_links_max: 0,
  backup: false,
  household: false,
};

const PLANS = new Set<string>(["free", "private", "connected", "founding"]);

function limit(value: unknown): number | null | undefined {
  if (value === null || value === "unlimited") return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return undefined;
}

function flag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const STATES = new Set(["choose", "trial", "subscribed", "lapsed", "paused", "ended"]);
const text = (v: unknown) => (typeof v === "string" ? v : null);

function parseAccess(raw: unknown): Access | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== "string" || !STATES.has(r.state)) return null;
  const plan = typeof r.plan === "string" && PLANS.has(r.plan) ? (r.plan as PlanName) : "free";
  return {
    state: r.state as Access["state"],
    plan,
    trial_ends_at: text(r.trial_ends_at),
    days: typeof r.days === "number" ? r.days : null,
    card_from: text(r.card_from),
    delete_at: text(r.delete_at),
    trial_used: r.trial_used === true,
  };
}

/** The server's object → a typed record, or null when any field is missing or odd. */
export function parseEntitlements(raw: unknown): Entitlements | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const plan = typeof r.plan === "string" && PLANS.has(r.plan) ? (r.plan as PlanName) : null;
  const goals = limit(r.goals_active_max);
  const accounts = limit(r.statement_accounts_max);
  const join = limit(r.groups_join_max);
  const banks = limit(r.bank_links_max);
  const create = flag(r.groups_create);
  const backup = flag(r.backup);
  const household = flag(r.household);
  if (
    plan === null ||
    goals === undefined ||
    accounts === undefined ||
    join === undefined ||
    banks === undefined ||
    create === undefined ||
    backup === undefined ||
    household === undefined
  )
    return null;
  return {
    plan,
    access: parseAccess(r.access),
    goals_active_max: goals,
    statement_accounts_max: accounts,
    groups_create: create,
    groups_join_max: join,
    bank_links_max: banks,
    backup,
    household,
  };
}

interface Store {
  userId: string | null;
  value: Entitlements;
  /** True once the value came from the server (now or cached), not the Free fallback. */
  known: boolean;
  fetched: boolean;
}

const initial = (): Store => ({
  userId: null,
  value: FREE_ENTITLEMENTS,
  known: false,
  fetched: false,
});
let store: Store = initial();
let inflight: Promise<void> | null = null;
let current: object | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => store;

const cacheKey = (userId: string) => `stackd.entitlements.${userId}`;

function readCache(userId: string): Entitlements | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    return raw ? parseEntitlements(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeCache(userId: string, value: Entitlements) {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(value));
  } catch {
    // private mode or full storage: the next sign-in asks the server again
  }
}

function select(userId: string) {
  if (store.userId === userId) return;
  const cached = readCache(userId);
  store = { userId, value: cached ?? FREE_ENTITLEMENTS, known: cached !== null, fetched: false };
  inflight = null;
  current = null;
  emit();
}

/** Ask the server once per sign-in (or again with `force`); keeps the last answer on failure. */
export function loadEntitlements(userId: string, force = false): Promise<void> {
  select(userId);
  if (inflight) return inflight;
  if (store.fetched && !force) return Promise.resolve();
  const token = {};
  current = token;
  const run = (async () => {
    try {
      const r = await api.GET("/api/billing/entitlements");
      if (store.userId !== userId) return;
      const parsed = failureOf(r) ? null : parseEntitlements(r.data);
      if (parsed) {
        writeCache(userId, parsed);
        store = { ...store, value: parsed, known: true, fetched: true };
        emit();
      }
    } catch {
      // offline: the cached or fallback limits stay
    } finally {
      if (current === token) {
        inflight = null;
        current = null;
      }
    }
  })();
  inflight = run;
  return run;
}

/** Tests: forget everything between cases. */
export function resetEntitlements(): void {
  store = initial();
  inflight = null;
  current = null;
}

export interface EntitlementsView {
  entitlements: Entitlements;
  /** False while only the Free fallback is known. */
  known: boolean;
  refresh: () => Promise<void>;
}

export function useEntitlements(): EntitlementsView {
  const { info } = useSession();
  const userId = info?.user?.id ?? null;
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (userId) void loadEntitlements(userId);
  }, [userId]);
  const current = s.userId === userId ? s : null;
  const cached = !current && userId ? readCache(userId) : null;
  return {
    entitlements: current?.value ?? cached ?? FREE_ENTITLEMENTS,
    known: current ? current.known : cached !== null,
    refresh: () => (userId ? loadEntitlements(userId, true) : Promise.resolve()),
  };
}

/** One line for the plan screen and the Me row: what the plan allows, in plain words. */
export function describeLimits(e: Entitlements): string {
  const n = (v: number | null, one: string, many: string) =>
    v === null ? `unlimited ${many}` : `${v} ${v === 1 ? one : many}`;
  const goals = n(e.goals_active_max, "jar or goal", "jars and goals");
  const accounts = n(e.statement_accounts_max, "statement account", "statement accounts");
  const groups = e.groups_create
    ? "start and join challenges"
    : e.groups_join_max === null
      ? "join challenges"
      : `join ${e.groups_join_max} challenge${e.groups_join_max === 1 ? "" : "s"} at a time`;
  return `${goals} · ${accounts} · ${groups}`;
}
