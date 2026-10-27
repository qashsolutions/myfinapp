/**
 * Service-worker updates (docs/spec.md "Update available"): the plugin tells us when a new
 * worker is waiting; the toast offers "Refresh"; nothing swaps underneath the user. The
 * register function is injected so tests can drive it without the plugin's virtual module.
 *
 * October 18, 2026: an installed app on iPhone is usually resumed, not reloaded, so the browser's
 * own check (on page load) rarely runs. The store asks the server again whenever the app comes
 * back to the foreground (at most once a minute) and every 30 minutes while it stays open.
 * `refresh()` is pull-to-refresh: a waiting version is applied, otherwise the page reloads.
 *
 * Each check also reads /version.json (never cached). If the server's build differs from the
 * one running, the toast shows even when the phone's offline copy never offered the new worker;
 * Refresh then takes the waiting worker if one turned up, else starts the offline copy afresh
 * (the worker is unregistered; data in the device database is untouched) and reloads.
 */

const CHECK_EVERY_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;

export interface RegisterOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
  onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
}

/** The part of a ServiceWorkerRegistration the store uses. */
export interface UpdatableRegistration {
  update: () => Promise<unknown>;
  waiting: unknown;
  unregister?: () => Promise<unknown>;
}

export type RegisterSW = (options: RegisterOptions) => (reload?: boolean) => Promise<void>;

export interface UpdateState {
  needRefresh: boolean;
  offlineReady: boolean;
}

export interface UpdateStore {
  get: () => UpdateState;
  subscribe: (listener: () => void) => () => void;
  /** Activates the waiting worker and reloads. */
  apply: () => Promise<void>;
  dismiss: () => void;
  /** Asks the server whether a new version exists (the toast appears when one is ready). */
  check: () => Promise<void>;
  /** Pull-to-refresh: the new version if one is ready, otherwise a plain reload. */
  refresh: () => Promise<void>;
}

export interface UpdateEnv {
  reload?: () => void;
  now?: () => number;
  doc?: Document | null;
  /** This build's id; "dev" and "test" never compare. */
  build?: string;
  /** The server's current build id, or null when it can't be read. */
  fetchBuild?: () => Promise<string | null>;
}

async function serverBuild(): Promise<string | null> {
  try {
    const r = await fetch("/version.json", { cache: "no-store" });
    if (!r.ok) return null;
    const body = (await r.json()) as { build?: unknown };
    return typeof body.build === "string" ? body.build : null;
  } catch {
    return null;
  }
}

export function createUpdateStore(register: RegisterSW, env: UpdateEnv = {}): UpdateStore {
  const reload = env.reload ?? (() => window.location.reload());
  const now = env.now ?? (() => Date.now());
  const doc = env.doc === undefined ? (typeof document === "undefined" ? null : document) : env.doc;
  const build = env.build ?? (typeof __BUILD_ID__ === "undefined" ? "dev" : __BUILD_ID__);
  const fetchBuild = env.fetchBuild ?? serverBuild;
  let registration: UpdatableRegistration | null = null;
  let lastCheck = 0;
  /** The server has a different build than this one. */
  let behind = false;
  let state: UpdateState = { needRefresh: false, offlineReady: false };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const update = register({
    immediate: true,
    onNeedRefresh: () => set({ needRefresh: true }),
    onOfflineReady: () => set({ offlineReady: true }),
    onRegisteredSW: (_url, reg) => {
      if (!reg) return;
      registration = reg;
      lastCheck = now();
      void compareBuild();
      setInterval(() => void check(true), CHECK_EVERY_MS);
      doc?.addEventListener("visibilitychange", () => {
        if (doc.visibilityState === "visible") void check(false);
      });
    },
  });
  async function compareBuild(): Promise<void> {
    if (build === "dev" || build === "test") return;
    const server = await fetchBuild();
    if (server && server !== "dev" && server !== build) {
      behind = true;
      if (!state.needRefresh) set({ needRefresh: true });
    }
  }
  async function check(force: boolean): Promise<void> {
    if (!registration) return;
    if (!force && now() - lastCheck < MIN_GAP_MS) return;
    lastCheck = now();
    try {
      await registration.update();
    } catch {
      // offline or the server is busy: the next check tries again
    }
    await compareBuild();
  }
  async function takeNewVersion(): Promise<void> {
    if (registration?.waiting || !behind || !registration) {
      await update(true);
      return;
    }
    // The server is ahead but no new worker is waiting: start the offline copy afresh.
    try {
      await registration.unregister?.();
    } catch {
      // nothing to undo; the reload still fetches the new page
    }
    reload();
  }
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: async () => {
      set({ needRefresh: false });
      await takeNewVersion();
    },
    dismiss: () => set({ needRefresh: false }),
    check: () => check(true),
    refresh: async () => {
      await check(true);
      if (state.needRefresh || registration?.waiting) {
        set({ needRefresh: false });
        await takeNewVersion();
        return;
      }
      reload();
    },
  };
}

let current: UpdateStore | null = null;

export function setUpdateStore(store: UpdateStore | null): void {
  current = store;
}

export function getUpdateStore(): UpdateStore | null {
  return current;
}
