/**
 * A fetch-level fake of services/api for the auth flows. Installed on globalThis.fetch, so
 * the real @stackd/api-client, the session store and every screen run unchanged.
 */

import type { components } from "@stackd/api-client";
import type {
  DeviceOut,
  GroupDetail,
  GroupMemberOut,
  PasskeyOut,
  SessionInfo,
} from "../src/data/api.ts";
import { cancelConsent, changeConsent, purchaseConsent, sameConsent } from "./fakeConsent.ts";

export const VALID_CODE = "482913";

/** Mirrors services/api/app/rules_server/plans.yaml (the server's table; this is the fake's). */
export const FAKE_LIMITS: Record<string, Record<string, unknown>> = {
  free: {
    goals_active_max: 2,
    statement_accounts_max: 1,
    groups_create: false,
    groups_join_max: 1,
    bank_links_max: 0,
    backup: false,
    household: false,
  },
  private: {
    goals_active_max: 4,
    statement_accounts_max: null,
    groups_create: true,
    groups_join_max: null,
    bank_links_max: 0,
    backup: true,
    household: false,
  },
  connected: {
    goals_active_max: 10,
    statement_accounts_max: null,
    groups_create: true,
    groups_join_max: null,
    bank_links_max: 3,
    backup: true,
    household: true,
  },
};

export interface FakeBackupBlob {
  id: string;
  ciphertext: string;
  key_version: number;
  snapshot_at: string;
  created_at: string;
  device_label: string;
}

export interface FakeBackup {
  key: Record<string, unknown> | null;
  blobs: FakeBackupBlob[];
}

export function emptyBackup(): FakeBackup {
  return { key: null, blobs: [] };
}

export interface FakeLinkedAccount {
  account_id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
}

export interface FakeConnection {
  id: string;
  institution_name: string;
  created_at: string;
  status: string;
  updates_available: boolean;
  last_synced_at: string | null;
}

export interface FakeSyncPage {
  added?: unknown[];
  modified?: unknown[];
  removed?: string[];
  balances?: unknown[];
  has_more?: boolean;
}

export interface FakeLinking {
  available: boolean;
  connections: FakeConnection[];
  sessions: string[];
  // `failed`: Plaid linked it but its accounts couldn't be read (the server revokes it)
  nextLink: Array<{ institution_name: string; accounts: FakeLinkedAccount[]; failed?: boolean }>;
  seq: number;
  /** Chunk 3.3: pages each connection's next syncs answer with, and the cursors asked for. */
  syncPages: Record<string, FakeSyncPage[]>;
  cursors: Array<{ connection_id: string; cursor: string | null }>;
  /** Chunk 3.4: "sign in again" sessions, by session id → connection id. */
  relinks: Record<string, string>;
  /** Chunk 3.5: what /cards answers per connection (the issuer's statement facts). */
  cards: Record<string, Array<components["schemas"]["CardDetail"]>>;
}

export function emptyLinking(): FakeLinking {
  return {
    available: true,
    connections: [],
    sessions: [],
    nextLink: [],
    seq: 0,
    syncPages: {},
    cursors: [],
    relinks: {},
    cards: {},
  };
}

export interface FakeHouseholdMember {
  user_id: string;
  display_name: string;
  initial: string;
  joined_at: string;
  left_at: string | null;
}

export interface FakeHouseholdRow {
  id: string;
  owner_id: string;
  created_at: string;
  members: FakeHouseholdMember[];
  invite: { code: string; expires_at: string; used: boolean } | null;
  blobs: Array<{
    author_id: string;
    kind: string;
    ciphertext: string;
    version: number;
    updated_at: string;
  }>;
}

/** Shared between two installs when a test plays both partners. */
export interface FakeHouseholds {
  rows: FakeHouseholdRow[];
  seq: number;
}

export function emptyHouseholds(): FakeHouseholds {
  return { rows: [], seq: 0 };
}

export interface FakeBilling {
  plan: "free" | "private" | "connected" | "founding";
  interval: "monthly" | "yearly" | null;
  status: string | null;
  renews_at: string | null;
  ends_at: string | null;
  cancel_at_period_end: boolean;
  has_customer: boolean;
  available: boolean;
  source?: "stripe" | "apple" | "google" | null;
  /** A downgrade is allowed from then (October 17, 2026: 30 days after a start or a switch). */
  downgrade_from?: string | null;
  /** A US bank payment still clearing (October 24, 2026). */
  payment_pending?: boolean;
  /** The plan was paid from a US bank account: refunds name the bank fee. */
  paid_by_bank?: boolean;
  /** GET /api/billing/credit: credit on the account, and what deleting it would refund. */
  credit_cents?: number;
  refund_cents?: number;
  /** What the refund is made of (invariant 61); "unused" (a yearly plan) unless set. */
  refund_kind?: "none" | "clearing" | "founding" | "unused" | "credit" | "mixed";
  /** GET /api/billing/history, oldest first here; cancel and resume add to it. */
  history?: Array<{
    kind: "trial_started" | "subscribed" | "switched" | "cancelled" | "resumed" | "ended";
    plan: string;
    interval: string | null;
    amount_cents: number | null;
    until: string | null;
    at: string;
  }>;
  /** The switch preview says linked banks would be disconnected. */
  disconnects_banks?: boolean;
  /** Tester tools (admins only, October 18, 2026) and the plan being tested. */
  tester?: boolean;
  tester_plan?: "free" | "private" | "connected" | "founding" | null;
  /** A household of two is one plan (invariant 54): whose plan covers whom. */
  shared?: "holder" | "covered" | null;
  shared_by?: string | null;
  /** Covered while paying for a plan of one's own (October 29, 2026). */
  own_plan?: "private" | "connected" | "founding" | null;
}

export function freeBilling(): FakeBilling {
  return {
    plan: "free",
    interval: null,
    status: null,
    renews_at: null,
    ends_at: null,
    cancel_at_period_end: false,
    has_customer: false,
    available: true,
  };
}

/** The default: Private yearly, as the mockup shows, so group tests can create and join freely. */
export function privateBilling(): FakeBilling {
  return {
    plan: "private",
    interval: "yearly",
    status: "active",
    renews_at: "2027-10-09T18:00:00Z",
    ends_at: null,
    cancel_at_period_end: false,
    has_customer: true,
    available: true,
  };
}

export function foundingBilling(): FakeBilling {
  return {
    plan: "founding",
    interval: null,
    status: "active",
    renews_at: null,
    ends_at: "2030-10-10T18:00:00Z",
    cancel_at_period_end: false,
    has_customer: true,
    available: true,
  };
}

export function fakeEntitlements(plan: FakeBilling["plan"]): Record<string, unknown> {
  return { plan, ...FAKE_LIMITS[plan === "founding" ? "connected" : plan] };
}

export interface FakeApi {
  session: SessionInfo;
  passkeys: PasskeyOut[];
  devices: DeviceOut[];
  /** Sign-in & security → Recent activity. */
  activity: Array<{ at: string; kind: string; device_label: string | null }>;
  /** Whether the account (not this device) already has passkeys when the code is verified. */
  accountHasPasskeys: boolean;
  wrongAttempts: number;
  /** The server's per-IP limit on code checks has been reached (October 24, 2026). */
  verifyRateLimited?: boolean;
  /** No network: every request fails the way fetch does offline (a TypeError). */
  offline?: boolean;
  /** This inbox may not buy again: a lost dispute or a fraud-warning refund (October 24, 2026). */
  purchaseBlocked?: boolean;
  passkeySignInUnknown: boolean;
  foundingLeft: number;
  /** Trials (October 14, 2026): what GET /api/billing/entitlements says under `access`. */
  access: Record<string, unknown> | null;
  /** When true, step-up endpoints answer 403 step_up_required until an assertion happens. */
  stepUpStale: boolean;
  /** Link with your phone (October 19, 2026): what the computer's next status check sees;
   * `null` until it asks for a code. `starts` counts codes; past 3 the start is rate-limited. */
  deviceLink: { code: string; status: "pending" | "approved" | "denied" | "expired" } | null;
  deviceLinkStarts: number;
  /** What the phone's lookup says about the computer's network. */
  deviceLinkSameNetwork: boolean;
  /** Every request: `path` and the parsed JSON `body` for the routes below; `url` (query string
   * included), `headers` and the raw body text so the leak sweep sees all of it. */
  calls: Array<{
    method: string;
    path: string;
    body?: unknown;
    url: string;
    headers: Record<string, string>;
    raw: string;
  }>;
  sentTo: string[];
  /** Groups on the "server"; `members` lists everyone, `is_me` is recomputed per response. */
  groups: FakeGroup[];
  codeSeq: number;
  notifications: {
    prefs: Record<string, Record<string, unknown>>;
    settings: Record<string, unknown>;
    subscribed: boolean;
  };
  schedule: Array<Record<string, unknown>>;
  billing: FakeBilling;
  backup: FakeBackup;
  households: FakeHouseholds;
  /** Linking (Phase 3): connections on the "server"; `nextLink` is what the next finish returns. */
  linking: FakeLinking;
}

export function defaultNotifications(): FakeApi["notifications"] {
  return {
    prefs: {
      upcoming_expense: {
        enabled: true,
        time_of_day: "09:00",
        days: null,
        lead_days: 3,
        threshold: null,
      },
      shortfall_risk: {
        enabled: true,
        time_of_day: "19:00",
        days: null,
        lead_days: null,
        threshold: null,
        delivery: "instant",
      },
      challenge_checkin: {
        enabled: true,
        time_of_day: "19:30",
        days: null,
        lead_days: null,
        threshold: null,
      },
      goal_behind_pace: {
        enabled: true,
        time_of_day: null,
        days: null,
        lead_days: null,
        threshold: 1,
      },
      milestone_reached: {
        enabled: true,
        time_of_day: "19:00",
        days: null,
        lead_days: null,
        threshold: null,
        delivery: "instant",
      },
      group_activity: {
        enabled: false,
        time_of_day: "19:00",
        days: null,
        lead_days: null,
        threshold: null,
        delivery: "instant",
      },
      weekly_recap: {
        enabled: true,
        time_of_day: "09:00",
        days: "0",
        lead_days: null,
        threshold: null,
        channel: "push",
      },
      budget_pace: {
        enabled: true,
        time_of_day: "09:00",
        days: null,
        lead_days: null,
        threshold: null,
      },
    },
    settings: {
      quiet_start: "21:00",
      quiet_end: "08:00",
      daily_max: 3,
      paused_until: null,
      timezone: "UTC",
    },
    subscribed: false,
  };
}

export interface FakeGroup
  extends Omit<
    GroupDetail,
    "is_owner" | "member_count" | "my_progress_bps" | "my_helped" | "helped" | "helped_open"
  > {
  owner_id: string;
  /** "What helped" answers by member id (the server shows totals only, from 2 answers). */
  answers?: Record<string, string[]>;
  /** The challenge has ended (the server reads its end date). */
  ended?: boolean;
  /** Members the owner removed (invariant 45): lookup and join answer 403 `removed`. */
  removed?: string[];
}

export const ME = "u1";

export function fakeMember(
  user_id: string,
  display_name: string,
  progress_bps: number,
  extra: Partial<GroupMemberOut> = {},
): GroupMemberOut {
  return {
    user_id,
    display_name,
    initial: display_name[0]?.toUpperCase() ?? "?",
    progress_bps,
    reached_at: progress_bps >= 10000 ? "2026-10-08T12:00:00Z" : null,
    has_events: progress_bps > 0,
    is_me: user_id === ME,
    is_owner: false,
    former: false,
    ...extra,
  };
}

/** Maya's group with three members and the code from the mockup; `u1` is not in it. */
export function mayasGroup(): FakeGroup {
  return {
    id: "g-maya",
    name: "October savings",
    template_key: "monthly_savings",
    start_date: "2026-10-01",
    end_date: "2026-10-31",
    invite_code: "STK-4F9Q",
    owner_id: "u-maya",
    members: [
      fakeMember("u-maya", "Maya R.", 8600, { is_owner: true }),
      fakeMember("u-dev", "Dev P.", 6400),
      fakeMember("u-sam", "Sam K.", 4300),
    ],
  };
}

export const signedOut = (): SessionInfo => ({
  authenticated: false,
  user: null,
  session_id: null,
  device_label: null,
  has_passkeys: false,
  locked: true,
  passkey_verified_at: null,
  lock_after_seconds: 300,
  step_up_max_age_seconds: 300,
});

export function readySession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    authenticated: true,
    user: { id: "u1", email: "maya.r@example.com", display_name: null, look: "modern" },
    session_id: "s1",
    device_label: "Safari on iPhone",
    has_passkeys: true,
    locked: false,
    passkey_verified_at: new Date().toISOString(),
    lock_after_seconds: 300,
    step_up_max_age_seconds: 300,
    ...overrides,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export function installFakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  const state: FakeApi = {
    session: signedOut(),
    passkeys: [],
    devices: [],
    activity: [],
    accountHasPasskeys: false,
    wrongAttempts: 0,
    passkeySignInUnknown: false,
    foundingLeft: 147,
    access: null,
    stepUpStale: false,
    deviceLink: null,
    deviceLinkStarts: 0,
    deviceLinkSameNetwork: true,
    calls: [],
    sentTo: [],
    groups: [],
    codeSeq: 0,
    notifications: defaultNotifications(),
    schedule: [],
    billing: privateBilling(),
    backup: emptyBackup(),
    households: emptyHouseholds(),
    linking: emptyLinking(),
    ...overrides,
  };
  const notificationsOut = () => ({
    prefs: state.notifications.prefs,
    settings: state.notifications.settings,
    push: { available: true, subscribed: state.notifications.subscribed },
  });

  const monthEnd = (month: string) => {
    const [y, m] = month.split("-").map(Number) as [number, number];
    return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  };
  const activeMembers = (g: FakeGroup) => g.members.filter((m) => !m.former);
  const helpedTotals = (g: FakeGroup) => {
    const answers = Object.values(g.answers ?? {}).filter((a) => a.length > 0);
    if (answers.length < 2) return null;
    const counts: Record<string, number> = {};
    for (const a of answers) for (const id of a) counts[id] = (counts[id] ?? 0) + 1;
    return { answered: answers.length, counts };
  };
  const detail = (g: FakeGroup): GroupDetail => {
    const me = g.members.find((m) => m.user_id === ME);
    return {
      id: g.id,
      name: g.name,
      template_key: g.template_key,
      start_date: g.start_date,
      end_date: g.end_date,
      invite_code: g.invite_code,
      is_owner: g.owner_id === ME,
      member_count: activeMembers(g).length,
      my_progress_bps: me?.progress_bps ?? 0,
      my_helped: g.answers?.[ME] ?? [],
      helped_open: Boolean(g.ended || me?.reached_at || (me?.progress_bps ?? 0) >= 10000),
      helped: helpedTotals(g),
      members: g.members.map((m) => ({
        ...m,
        is_me: m.user_id === ME,
        is_owner: m.user_id === g.owner_id,
      })),
    };
  };
  const summary = (g: FakeGroup) => {
    const { members: _members, helped: _h, helped_open: _o, ...rest } = detail(g);
    return rest;
  };
  const myGroups = () => state.groups.filter((g) => g.members.some((m) => m.user_id === ME));
  const byCode = (code: string) =>
    state.groups.find((g) => g.invite_code === code.trim().toUpperCase().replace(/\s+/g, ""));
  const myName = () => state.session.user?.display_name ?? "Member";

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (state.offline) throw new TypeError("Failed to fetch"); // nothing reaches the server
    const raw = method === "GET" || method === "HEAD" ? "" : await request.text().catch(() => "");
    let body: unknown;
    if (method !== "GET" && method !== "DELETE" && raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }
    const headers = Object.fromEntries(request.headers.entries());
    state.calls.push({ method, path, body, url: request.url, headers, raw });
    const b = (body ?? {}) as Record<string, string>;
    const now = new Date().toISOString();

    if (method === "GET" && path === "/api/auth/session") return json(state.session);
    if (method === "POST" && path === "/api/auth/otp/send") {
      state.sentTo.push(b.email ?? "");
      return json({ sent: true, resend_after_seconds: 60, expires_in_seconds: 600 });
    }
    if (method === "POST" && path === "/api/auth/otp/verify") {
      if (state.verifyRateLimited)
        return json({ detail: "rate_limited" }, 429, { "retry-after": "600" });
      if (b.code !== VALID_CODE) {
        state.wrongAttempts += 1;
        if (state.wrongAttempts >= 5)
          return json({ detail: "locked" }, 423, { "retry-after": "900" });
        return json(
          { detail: { code: "wrong_code", attempts_left: 5 - state.wrongAttempts } },
          400,
        );
      }
      state.session = readySession({
        user: { id: "u1", email: b.email ?? "", display_name: null, look: "modern" },
        has_passkeys: state.accountHasPasskeys,
        locked: true,
        passkey_verified_at: null,
      });
      return json(state.session);
    }
    // Passkey sign-in with no email (October 13, 2026): any passkey the fake holds signs in
    // as the account with passkeys; `passkeySignInUnknown` makes it a passkey we never saw.
    if (method === "POST" && path === "/api/auth/passkey/options") {
      return json({
        options: { challenge: "c2lnbmlu", rpId: "localhost", userVerification: "required" },
      });
    }
    if (method === "POST" && path === "/api/auth/passkey/verify") {
      if (state.passkeySignInUnknown) return json({ detail: "unknown_credential" }, 400);
      state.session = readySession();
      return json(state.session);
    }
    if (method === "POST" && path === "/api/auth/link/start") {
      state.deviceLinkStarts += 1;
      if (state.deviceLinkStarts > 3)
        return json({ detail: "rate_limited" }, 429, { "retry-after": "3600" });
      state.deviceLink = {
        code: `ABCD-EF${String(state.deviceLinkStarts).padStart(2, "G")}`,
        status: "pending",
      };
      return json({ code: state.deviceLink.code, expires_in_seconds: 120 });
    }
    if (method === "GET" && path === "/api/auth/link/status") {
      const link = state.deviceLink;
      if (!link) return json({ detail: "not_found" }, 404);
      if (link.status !== "approved") return json({ status: link.status, session: null });
      state.deviceLink = null; // picked up once
      // Unlocked, but no passkey check on this computer yet (invariant 44): step-up asks first.
      state.session = readySession({ passkey_verified_at: null });
      return json({ status: "approved", session: state.session });
    }
    if (method === "POST" && path === "/api/auth/signout") {
      state.session = signedOut();
      return json(state.session);
    }
    if (!state.session.authenticated) return json({ detail: "sign_in_required" }, 401);
    if (method === "POST" && path === "/api/auth/lock") {
      state.session = { ...state.session, locked: true };
      return new Response(null, { status: 204 });
    }

    if (method === "POST" && path === "/api/security/passkeys/register/options") {
      // A passkey after the first needs a fresh check on this device, as on the server.
      const at = state.session.passkey_verified_at;
      const fresh = at !== null && at !== undefined && Date.now() - Date.parse(at) < 300_000;
      if (state.session.has_passkeys && (!fresh || state.stepUpStale))
        return json({ detail: "step_up_required" }, 403);
      return json({ options: { challenge: "c1", rp: { id: "localhost" } } });
    }
    if (method === "POST" && path === "/api/security/passkeys/register/verify") {
      const pk: PasskeyOut = {
        id: `pk${state.passkeys.length + 1}`,
        label: "iPhone passkey",
        created_at: now,
        last_used_at: now,
      };
      state.passkeys.push(pk);
      state.session = {
        ...state.session,
        has_passkeys: true,
        locked: false,
        passkey_verified_at: now,
      };
      state.stepUpStale = false;
      return json(pk);
    }
    if (method === "POST" && path === "/api/security/passkeys/assert/options") {
      if (!state.session.has_passkeys) return json({ detail: "no_passkeys" }, 409);
      return json({ options: { challenge: "c2", allowCredentials: [] } });
    }
    if (method === "POST" && path === "/api/security/passkeys/assert/verify") {
      state.session = { ...state.session, locked: false, passkey_verified_at: now };
      state.stepUpStale = false;
      return json({ passkey_verified_at: now, locked: false });
    }
    if (state.session.locked) return json({ detail: "locked" }, 403);

    if (method === "POST" && path.startsWith("/api/auth/link/")) {
      const code = (body as { code?: string } | undefined)?.code ?? "";
      const link = state.deviceLink;
      if (!link || link.code !== code) return json({ detail: "not_found" }, 404);
      // Each request is answered once (October 28, 2026): approved or denied, then closed.
      if (link.status !== "pending") return json({ detail: "already_answered" }, 409);
      if (path === "/api/auth/link/lookup")
        return json({
          device_label: "Chrome on Mac",
          requested_at: new Date().toISOString(),
          expires_in_seconds: 95,
          same_network: state.deviceLinkSameNetwork,
        });
      if (path === "/api/auth/link/approve") {
        if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
        const confirmed = (body as { confirm_different_network?: boolean })
          .confirm_different_network;
        if (!state.deviceLinkSameNetwork && !confirmed)
          return json({ detail: "different_network" }, 409);
        link.status = "approved";
        return json({ status: "approved", session: null });
      }
      if (path === "/api/auth/link/deny") {
        link.status = "denied";
        return json({ status: "denied", session: null });
      }
    }
    if (method === "GET" && path === "/api/security/passkeys") return json(state.passkeys);
    if (method === "GET" && path === "/api/security/devices") return json(state.devices);
    if (method === "GET" && path === "/api/security/activity") return json(state.activity);
    const pkDelete = path.match(/^\/api\/security\/passkeys\/(.+)$/);
    if (method === "DELETE" && pkDelete) {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (state.passkeys.length <= 1) return json({ detail: "last_passkey" }, 409);
      state.passkeys = state.passkeys.filter((p) => p.id !== pkDelete[1]);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT" && path === "/api/security/lock") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      const minutes = Number((b as { minutes?: unknown }).minutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60)
        return json({ detail: "invalid" }, 422);
      state.session = { ...state.session, lock_after_seconds: minutes * 60 };
      return json({ minutes });
    }
    const devDelete = path.match(/^\/api\/security\/devices\/(.+)$/);
    if (method === "DELETE" && devDelete) {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      state.devices = state.devices.filter((d) => d.id !== devDelete[1]);
      return new Response(null, { status: 204 });
    }

    if (method === "GET" && path === "/api/notifications/settings") return json(notificationsOut());
    if (method === "PUT" && path === "/api/notifications/settings") {
      const patch = body as {
        prefs?: Record<string, Record<string, unknown>>;
        settings?: Record<string, unknown>;
      };
      for (const [kind, values] of Object.entries(patch.prefs ?? {}))
        state.notifications.prefs[kind] = { ...(state.notifications.prefs[kind] ?? {}), ...values };
      const s = patch.settings ?? {};
      const { pause, ...rest } = s as { pause?: string } & Record<string, unknown>;
      Object.assign(state.notifications.settings, rest);
      if (pause === "none") state.notifications.settings.paused_until = null;
      else if (pause)
        state.notifications.settings.paused_until = new Date(
          Date.now() + (pause === "day" ? 1 : 7) * 86400000,
        ).toISOString();
      return json(notificationsOut());
    }
    if (method === "GET" && path === "/api/notifications/push/key")
      return json({ public_key: "BPUBLICKEY" });
    if (method === "POST" && path === "/api/notifications/push") {
      state.notifications.subscribed = true;
      return json({ available: true, subscribed: true }, 201);
    }
    if (method === "POST" && path === "/api/notifications/push/native") {
      state.notifications.subscribed = true;
      return json({ available: true, subscribed: true }, 201);
    }
    if (method === "POST" && path === "/api/notifications/push/native/unsubscribe") {
      state.notifications.subscribed = false;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/api/notifications/push/unsubscribe") {
      state.notifications.subscribed = false;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/api/notifications/push/test") return json({ delivered: 1 });
    if (method === "GET" && path === "/api/alerts/schedule")
      return json({ registered: 0, items: state.schedule });
    if (method === "PUT" && path === "/api/alerts/schedule") {
      const items = ((body as { items?: Array<Record<string, unknown>> }).items ?? []).map((i) => ({
        ...i,
        generic_label: "label",
        status: "pending",
      }));
      state.schedule = items;
      return json({ registered: items.length, items });
    }
    if (method === "POST" && path === "/api/account/export") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      return json({
        exported_at: now,
        profile: {
          id: ME,
          email: state.session.user?.email ?? "",
          display_name: state.session.user?.display_name ?? null,
          look: "modern",
          mode: "system",
          simple_layout: false,
          receipt_retention: "90d",
          created_at: "2026-10-01T00:00:00Z",
        },
        groups: myGroups().map(summary),
        plan: {
          name: state.billing.plan,
          status: state.billing.status,
          interval: state.billing.interval,
          renews_at: state.billing.renews_at,
          ends_at: state.billing.ends_at,
        },
      });
    }
    if (method === "POST" && path === "/api/account/delete") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (b.confirm !== "DELETE") return json({ detail: "invalid" }, 422);
      state.session = signedOut();
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/api/account/email/send") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (b.new_email === state.session.user?.email) return json({ detail: "same_email" }, 409);
      if (b.new_email === "taken@example.com") return json({ detail: "email_taken" }, 409);
      state.sentTo.push(String(b.new_email ?? ""));
      return json({ sent: true, resend_after_seconds: 60, expires_in_seconds: 600 });
    }
    if (method === "POST" && path === "/api/account/email/verify") {
      if (b.code !== VALID_CODE)
        return json({ detail: { code: "wrong_code", attempts_left: 4 } }, 400);
      if (state.session.user)
        state.session = {
          ...state.session,
          user: { ...state.session.user, email: String(b.new_email) },
        };
      return json({
        email: String(b.new_email),
        display_name: state.session.user?.display_name ?? null,
      });
    }
    if (method === "PATCH" && path === "/api/account") {
      if (b.display_name === undefined && b.look === undefined)
        return json({ detail: "nothing_to_change" }, 422);
      if (b.look !== undefined) {
        if (!["modern", "pastel", "anime"].includes(String(b.look)))
          return json({ detail: "invalid" }, 422);
        if (state.session.user)
          state.session = {
            ...state.session,
            user: { ...state.session.user, look: String(b.look) },
          };
      }
      if (b.display_name !== undefined) {
        const name = String(b.display_name ?? "").trim();
        if (!name || name.length > 40) return json({ detail: "invalid_name" }, 422);
        if (state.session.user)
          state.session = {
            ...state.session,
            user: { ...state.session.user, display_name: name },
          };
        for (const g of state.groups)
          for (const m of g.members)
            if (m.user_id === ME) {
              m.display_name = name;
              m.initial = name[0]?.toUpperCase() ?? "?";
            }
      }
      return json({
        email: state.session.user?.email ?? "",
        display_name: state.session.user?.display_name ?? null,
        look: state.session.user?.look ?? "modern",
      });
    }
    const limits =
      FAKE_LIMITS[state.billing.plan === "founding" ? "connected" : state.billing.plan];
    const me = state.session.user?.id ?? ME;
    const deviceLabel = state.session.device_label ?? "Safari on iPhone";
    // Linking (Phase 3, chunk 3.2): Hosted Link URLs, finish once, disconnect.
    if (method === "GET" && path === "/api/linking") {
      const cap = limits?.bank_links_max;
      return json({
        available: state.linking.available,
        max_connections: cap === null || cap === undefined ? null : Number(cap),
        connections: state.linking.connections,
      });
    }
    if (method === "POST" && path === "/api/linking/start") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (!state.linking.available) return json({ detail: "linking_unavailable" }, 503);
      if (state.linking.connections.length >= Number(limits?.bank_links_max ?? 0))
        return json({ detail: "plan_limit" }, 403);
      state.linking.seq += 1;
      const id = `ls${state.linking.seq}`;
      state.linking.sessions.push(id);
      return json({ session_id: id, url: `https://hosted.plaid.com/link/${id}` });
    }
    const relinkMatch = path.match(/^\/api\/linking\/([^/]+)\/relink$/);
    if (method === "POST" && relinkMatch) {
      const conn = state.linking.connections.find((c) => c.id === relinkMatch[1]);
      if (!conn) return json({ detail: "not_found" }, 404);
      state.linking.seq += 1;
      const id = `lr${state.linking.seq}`;
      state.linking.relinks[id] = conn.id;
      return json({ session_id: id, url: `https://hosted.plaid.com/link/${id}` });
    }
    if (
      method === "POST" &&
      path === "/api/linking/finish" &&
      state.linking.relinks[String(b.session_id)]
    ) {
      const conn = state.linking.connections.find(
        (c) => c.id === state.linking.relinks[String(b.session_id)],
      );
      delete state.linking.relinks[String(b.session_id)];
      if (!conn) return json({ detail: "not_found" }, 404);
      conn.status = "ok";
      return json({ status: "linked", connections: [{ ...conn, accounts: [] }] });
    }
    if (method === "POST" && path === "/api/linking/finish") {
      const id = String(b.session_id);
      if (!state.linking.sessions.includes(id)) return json({ detail: "not_found" }, 404);
      state.linking.sessions = state.linking.sessions.filter((x) => x !== id);
      if (state.linking.nextLink.length === 0)
        return json({ status: "cancelled", connections: [], already_linked: [] });
      // Like the server: a bank with a working connection already is never linked twice.
      const working = (name: string) =>
        state.linking.connections.some(
          (c) =>
            c.institution_name === name && (c.status === "ok" || c.status === "login_required"),
        );
      const already = state.linking.nextLink
        .filter((l) => working(l.institution_name))
        .map((l) => l.institution_name);
      const failed = state.linking.nextLink
        .filter((l) => l.failed && !working(l.institution_name))
        .map((l) => l.institution_name);
      const fresh = state.linking.nextLink.filter((l) => !l.failed && !working(l.institution_name));
      if (fresh.length === 0) {
        state.linking.nextLink = [];
        if (already.length === 0) return json({ detail: "provider_error" }, 502);
        return json({ status: "already_linked", connections: [], already_linked: already, failed });
      }
      const connections = fresh.map((l) => {
        state.linking.seq += 1;
        const row: FakeConnection = {
          id: `bc${state.linking.seq}`,
          institution_name: l.institution_name,
          created_at: now,
          status: "ok",
          updates_available: false,
          last_synced_at: null,
        };
        state.linking.connections.push(row);
        return { ...row, accounts: l.accounts };
      });
      state.linking.nextLink = [];
      return json({ status: "linked", connections, already_linked: already, failed });
    }
    const cardsMatch = path.match(/^\/api\/linking\/([^/]+)\/cards$/);
    if (method === "POST" && cardsMatch) {
      const conn = state.linking.connections.find((c) => c.id === cardsMatch[1]);
      if (!conn) return json({ detail: "not_found" }, 404);
      return json({ cards: state.linking.cards[conn.id] ?? [] });
    }
    const syncMatch = path.match(/^\/api\/linking\/([^/]+)\/sync$/);
    if (method === "POST" && syncMatch) {
      const conn = state.linking.connections.find((c) => c.id === syncMatch[1]);
      if (!conn) return json({ detail: "not_found" }, 404);
      if (conn.status === "login_required") return json({ detail: "login_required" }, 409);
      state.linking.cursors.push({
        connection_id: conn.id,
        cursor: (b.cursor as string | null | undefined) ?? null,
      });
      const page = state.linking.syncPages[conn.id]?.shift() ?? {};
      state.linking.seq += 1;
      conn.last_synced_at = now;
      conn.updates_available = false;
      return json({
        added: page.added ?? [],
        modified: page.modified ?? [],
        removed: page.removed ?? [],
        balances: page.balances ?? [],
        next_cursor: `cur-${state.linking.seq}`,
        has_more: page.has_more ?? false,
      });
    }
    const unlink = path.match(/^\/api\/linking\/([^/]+)$/);
    if (method === "DELETE" && unlink) {
      const before = state.linking.connections.length;
      state.linking.connections = state.linking.connections.filter((c) => c.id !== unlink[1]);
      if (state.linking.connections.length === before) return json({ detail: "not_found" }, 404);
      return new Response(null, { status: 204 });
    }
    // Encrypted backup (chunk 1.16): the fake stores whatever ciphertext it is handed.
    if (method === "GET" && path === "/api/backup") {
      const latest = state.backup.blobs.at(-1) ?? null;
      const devices = new Map<string, string>();
      for (const blob of [...state.backup.blobs].reverse())
        if (!devices.has(blob.device_label)) devices.set(blob.device_label, blob.created_at);
      return json({
        enabled: state.backup.key !== null,
        available: !!limits?.backup,
        key: state.backup.key,
        latest: latest
          ? {
              id: latest.id,
              created_at: latest.created_at,
              size: latest.ciphertext.length,
              key_version: latest.key_version,
              snapshot_at: latest.snapshot_at,
              device_label: latest.device_label,
            }
          : null,
        devices: [...devices].map(([label, last_backup_at]) => ({ label, last_backup_at })),
      });
    }
    if (method === "PUT" && path === "/api/backup/key") {
      if (!limits?.backup) return json({ detail: "plan_required" }, 403);
      state.backup.key = { ...(body as Record<string, unknown>), created_at: now, updated_at: now };
      return json(state.backup.key);
    }
    if (method === "PUT" && path === "/api/backup/blob") {
      if (!limits?.backup) return json({ detail: "plan_required" }, 403);
      if (!state.backup.key) return json({ detail: "no_key" }, 409);
      state.codeSeq += 1;
      const blob: FakeBackupBlob = {
        id: `bk${state.codeSeq}`,
        ciphertext: String(b.ciphertext),
        key_version: Number(b.key_version),
        snapshot_at: String(b.snapshot_at),
        created_at: now,
        device_label: deviceLabel,
      };
      state.backup.blobs.push(blob);
      while (state.backup.blobs.length > 3) state.backup.blobs.shift();
      const { ciphertext: _c, ...out } = blob;
      return json({ ...out, size: blob.ciphertext.length });
    }
    if (method === "GET" && path === "/api/backup/blob/latest") {
      const before = new URL(request.url).searchParams.get("before");
      const at = before ? state.backup.blobs.findIndex((x) => x.id === before) : -1;
      // As the server: a `before` copy that is gone (pruned mid-walk) is its own answer
      if (before && at === -1) return json({ detail: "backup_gone" }, 409);
      const pool = before ? state.backup.blobs.slice(0, at) : state.backup.blobs;
      const latest = pool.at(-1);
      if (!latest) return json({ detail: "no_backup" }, 404);
      return json({ ...latest, size: latest.ciphertext.length });
    }
    if (method === "DELETE" && path === "/api/backup") {
      state.backup.key = null;
      state.backup.blobs = [];
      return new Response(null, { status: 204 });
    }
    // Couples & household (chunk 1.16)
    const myHousehold = () =>
      state.households.rows.find((h) =>
        h.members.some((m) => m.user_id === me && m.left_at === null),
      ) ?? null;
    const householdOut = (h: FakeHouseholdRow) => {
      const members = h.members.filter((m) => m.left_at === null);
      return {
        id: h.id,
        owner_id: h.owner_id,
        created_at: h.created_at,
        members: members.map((m) => ({
          user_id: m.user_id,
          display_name: m.display_name,
          initial: m.initial,
          is_me: m.user_id === me,
          joined_at: m.joined_at,
        })),
        invite:
          h.invite && !h.invite.used && members.length < 2
            ? { code: h.invite.code, expires_at: h.invite.expires_at }
            : null,
      };
    };
    const myNameNow = () => state.session.user?.display_name ?? "Member";
    const memberRow = (): FakeHouseholdMember => ({
      user_id: me,
      display_name: myNameNow(),
      initial: myNameNow()[0]?.toUpperCase() ?? "?",
      joined_at: now,
      left_at: null,
    });
    if (method === "GET" && path === "/api/household") {
      const h = myHousehold();
      return json({ household: h ? householdOut(h) : null, available: !!limits?.household });
    }
    if (method === "POST" && path === "/api/household/invites") {
      if (!limits?.household) return json({ detail: "plan_required" }, 403);
      let h = myHousehold();
      if (!h) {
        state.households.seq += 1;
        h = {
          id: `hh${state.households.seq}`,
          owner_id: me,
          created_at: now,
          members: [memberRow()],
          invite: null,
          blobs: [],
        };
        state.households.rows.push(h);
      }
      if (h.members.filter((m) => m.left_at === null).length >= 2)
        return json({ detail: "household_full" }, 409);
      state.households.seq += 1;
      h.invite = {
        code: `HH-KEY${String(state.households.seq).padStart(3, "0")}`,
        expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        used: false,
      };
      return json({ code: h.invite.code, expires_at: h.invite.expires_at }, 201);
    }
    const byHouseholdCode = (code: string) =>
      state.households.rows.find(
        (h) => h.invite && !h.invite.used && h.invite.code === code.trim().toUpperCase(),
      ) ?? null;
    if (method === "POST" && path === "/api/household/lookup") {
      const h = byHouseholdCode(String(b.code ?? ""));
      if (!h) return json({ detail: "not_found" }, 404);
      const owner = h.members.find((m) => m.user_id === h.owner_id);
      return json({
        invited_by: owner?.display_name ?? "Former member",
        initial: owner?.initial ?? "-",
        expires_at: h.invite?.expires_at,
        // Like the server: the joiner's own renewing plan, so the screen can ask about it.
        you_pay:
          (state.billing.plan === "private" || state.billing.plan === "connected") &&
          state.billing.status === "active" &&
          state.billing.interval &&
          !state.billing.cancel_at_period_end
            ? {
                plan: state.billing.plan,
                label: state.billing.plan === "private" ? "Private" : "Connected",
                renews_at: state.billing.renews_at,
                source: state.billing.source ?? "stripe",
              }
            : null,
      });
    }
    if (method === "POST" && path === "/api/household/join") {
      if (myHousehold()) return json({ detail: "already_in_household" }, 409);
      const h = byHouseholdCode(String(b.code ?? ""));
      if (!h) return json({ detail: "not_found" }, 404);
      if (h.members.filter((m) => m.left_at === null).length >= 2)
        return json({ detail: "household_full" }, 409);
      const owner = h.members.find((m) => m.left_at === null);
      h.members.push(memberRow());
      if (h.invite) h.invite.used = true;
      // Like the server (invariant 54): the owner's plan covers whoever joins, from now on.
      if (state.access !== null && state.billing.plan !== "connected") {
        const own = state.billing.status === "active" ? state.billing.plan : null;
        state.billing = {
          ...state.billing,
          plan: "connected",
          shared: "covered",
          shared_by: owner?.display_name ?? null,
          own_plan: own === "free" ? null : own,
        };
        state.access = { state: "subscribed", plan: "connected", shared: "covered" };
      }
      return json(householdOut(h));
    }
    if (method === "POST" && path === "/api/household/leave") {
      const h = myHousehold();
      if (!h) return json({ detail: "not_found" }, 404);
      for (const m of h.members) if (m.user_id === me && m.left_at === null) m.left_at = now;
      h.blobs = h.blobs.filter((x) => x.author_id !== me);
      if (!h.members.some((m) => m.left_at === null))
        state.households.rows = state.households.rows.filter((x) => x.id !== h.id);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/api/household/blobs") {
      const h = myHousehold();
      if (!h) return json({ detail: "not_found" }, 404);
      return json(h.blobs);
    }
    const blobPath = path.match(/^\/api\/household\/blobs\/(jars|summary)$/);
    if (method === "PUT" && blobPath) {
      const h = myHousehold();
      if (!h) return json({ detail: "not_found" }, 404);
      const kind = blobPath[1] as string;
      const existing = h.blobs.find((x) => x.author_id === me && x.kind === kind);
      if (existing) {
        existing.ciphertext = String(b.ciphertext);
        existing.version = Number(b.version);
        existing.updated_at = now;
      } else
        h.blobs.push({
          author_id: me,
          kind,
          ciphertext: String(b.ciphertext),
          version: Number(b.version),
          updated_at: now,
        });
      return json({ kind, version: Number(b.version), updated_at: now });
    }
    if (method === "GET" && path === "/api/billing/entitlements")
      return json({ ...fakeEntitlements(state.billing.plan), access: state.access });
    if (method === "POST" && path === "/api/billing/trial") {
      if (state.access?.state !== "choose") return json({ detail: "trial_not_available" }, 409);
      if (state.access.trial_used) return json({ detail: "trial_used" }, 409);
      const plan = b.plan === "connected" ? "connected" : "private";
      const days = 3; // either plan (owner decision, October 22, 2026)
      const ends = new Date(Date.now() + days * 86_400_000);
      state.billing = { ...state.billing, plan };
      state.access = {
        state: "trial",
        plan,
        days,
        trial_ends_at: ends.toISOString(),
        card_from: new Date(ends.getTime() - 2 * 86_400_000).toISOString(),
      };
      return json({ ...fakeEntitlements(plan), access: state.access });
    }
    const billingOut = () => {
      const labels = {
        free: "Free",
        private: "Private",
        connected: "Connected",
        founding: "Founding member",
      };
      const plan = state.billing.tester_plan ?? state.billing.plan;
      return {
        ...state.billing,
        plan,
        tester: !!state.billing.tester,
        tester_plan: state.billing.tester_plan ?? null,
        label: labels[plan],
        source: state.billing.plan === "free" ? null : (state.billing.source ?? "stripe"),
        prices: {
          free: { monthly_cents: 0, yearly_cents: 0 },
          private: { monthly_cents: 300, yearly_cents: 2000 },
          connected: { monthly_cents: 700, yearly_cents: 6500 },
        },
        founding: {
          one_time_cents: 15000,
          term_years: 4,
          cap: 250,
          auto_renew: false,
          left: state.foundingLeft,
        },
        entitlements: { ...fakeEntitlements(plan), access: state.access },
        trials: { private: 3, connected: 3 },
        store_products: {
          private: {
            monthly: "com.stackd.app.private.monthly",
            yearly: "com.stackd.app.private.yearly",
          },
          connected: {
            monthly: "com.stackd.app.connected.monthly",
            yearly: "com.stackd.app.connected.yearly",
          },
        },
      };
    };
    if (method === "GET" && path === "/api/billing") return json(billingOut());
    if (method === "POST" && path === "/api/billing/native/sync") {
      // The fake trusts a proof shaped "proof:<plan>:<interval>" (tests mint them)
      const proof = String(b.jws ?? b.purchase_token ?? "");
      const [, plan, interval] = proof.split(":");
      if (plan !== "private" && plan !== "connected") return json({ detail: "bad_signature" }, 400);
      state.billing = {
        ...state.billing,
        plan,
        interval: interval === "monthly" ? "monthly" : "yearly",
        status: "active",
        renews_at: "2027-10-11T00:00:00Z",
        source: b.platform === "ios" ? "apple" : "google",
      };
      return json(billingOut());
    }
    // Plan changes, as the server decides them: up (Private → Connected, monthly → yearly) at
    // once for the difference; down at the end of the paid period.
    const tier = { private: 1, connected: 2 } as const;
    const prices = {
      private: { monthly: 300, yearly: 2000 },
      connected: { monthly: 700, yearly: 6500 },
    } as const;
    const renewing = () =>
      (state.billing.plan === "private" || state.billing.plan === "connected") &&
      (state.billing.source ?? "stripe") === "stripe" &&
      state.billing.status === "active";
    const changeKind = (plan: "private" | "connected", interval: "monthly" | "yearly") => {
      const cur = state.billing.plan as "private" | "connected";
      if (cur === plan && state.billing.interval === interval) return "same";
      if (tier[plan] > tier[cur]) return "up";
      if (plan === cur && interval === "yearly") return "up";
      return "down";
    };
    const tooSoon = () =>
      !!state.billing.downgrade_from && new Date(state.billing.downgrade_from) > new Date();
    if (method === "POST" && path === "/api/billing/tester") {
      if (!state.billing.tester) return json({ detail: "not_found" }, 404);
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      state.billing = {
        ...state.billing,
        tester_plan: (b.plan ?? null) as FakeBilling["tester_plan"],
      };
      return json(billingOut());
    }
    if (method === "GET" && path === "/api/billing/credit") {
      const refund = state.billing.refund_cents ?? 0;
      const kind = refund ? (state.billing.refund_kind ?? "unused") : "none";
      const clearing = kind === "clearing"; // all of it, no fee, no month kept
      return json({
        credit_cents: state.billing.credit_cents ?? 0,
        refund_if_deleted_cents: refund,
        kept_until: refund && !clearing ? "2026-11-09T18:00:00Z" : null,
        refund_before_fee_cents: refund ? refund + (clearing ? 0 : 195) : 0,
        refund_kind: kind,
        refund_fee_bps: 290,
        refund_fee_fixed_cents: 30,
        refund_fee_method: state.billing.paid_by_bank ? "bank" : "card",
        refund_bank_fee_bps: 80,
        refund_bank_fee_cap_cents: 500,
      });
    }
    // What a switch charges, and the server's "Change your plan" lines for it.
    const switchFor = (plan: "private" | "connected", interval: "monthly" | "yearly") => {
      const kind = changeKind(plan, interval);
      const amounts = {
        kind,
        due_now_cents: kind === "up" ? 512 : 0,
        credit_after_cents: kind === "down" ? 7199 : 0,
      };
      const disconnects = kind === "down" && !!state.billing.disconnects_banks;
      return {
        ...amounts,
        price_cents: prices[plan][interval],
        proration_date: 1_792_000_000,
        disconnects_banks: disconnects,
        consent: changeConsent(plan, interval, amounts, disconnects, billingOut().label),
      };
    };
    const trialEnd = () =>
      state.access?.state === "trial" ? String(state.access.trial_ends_at ?? "") || null : null;
    const cancelText = () =>
      cancelConsent(
        billingOut().label,
        state.billing.renews_at ?? null,
        state.billing.refund_cents ?? 0,
      );
    if (method === "GET" && path === "/api/billing/consent/purchase") {
      const q = new URL(request.url).searchParams;
      const plan = q.get("plan") as "private" | "connected" | "founding";
      const interval = q.get("interval") as "monthly" | "yearly" | null;
      if (plan !== "founding" && !interval) return json({ detail: "interval_required" }, 422);
      return json(purchaseConsent(plan, interval, trialEnd()));
    }
    if (method === "GET" && path === "/api/billing/consent/cancel") {
      if (state.billing.plan === "free" || state.billing.plan === "founding")
        return json({ detail: "no_subscription" }, 404);
      return json(cancelText());
    }
    if (method === "POST" && path === "/api/billing/change/preview") {
      if (!renewing()) return json({ detail: "no_subscription" }, 404);
      const plan = b.plan as "private" | "connected";
      const interval = b.interval as "monthly" | "yearly";
      const kind = changeKind(plan, interval);
      if (kind === "down" && tooSoon()) return json({ detail: "downgrade_too_soon" }, 409);
      return json(switchFor(plan, interval));
    }
    if (method === "POST" && path === "/api/billing/change") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (!renewing()) return json({ detail: "no_subscription" }, 404);
      const plan = b.plan as "private" | "connected";
      const interval = b.interval as "monthly" | "yearly";
      const kind = changeKind(plan, interval);
      if (kind === "same") return json(billingOut());
      if (kind === "down" && tooSoon()) return json({ detail: "downgrade_too_soon" }, 409);
      if (!b.consent) return json({ detail: "consent_required" }, 422);
      if (!sameConsent(b.consent, switchFor(plan, interval).consent))
        return json({ detail: "consent_mismatch" }, 409);
      state.billing = {
        ...state.billing,
        plan,
        interval,
        cancel_at_period_end: false,
        downgrade_from: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        credit_cents: kind === "down" ? 7199 : (state.billing.credit_cents ?? 0),
      };
      return json(billingOut());
    }
    if (method === "POST" && path === "/api/billing/checkout") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (!state.billing.available) return json({ detail: "billing_unavailable" }, 503);
      if (state.purchaseBlocked) return json({ detail: "purchase_blocked" }, 403);
      if (state.billing.plan === "founding") return json({ detail: "already_founding" }, 409);
      if (renewing() && b.plan !== "founding") return json({ detail: "already_subscribed" }, 409);
      if (renewing() && !state.billing.cancel_at_period_end)
        return json({ detail: "cancel_first" }, 409);
      if (b.plan !== "founding" && !b.interval) return json({ detail: "interval_required" }, 422);
      const offer = purchaseConsent(
        b.plan as "private" | "connected" | "founding",
        (b.interval ?? null) as "monthly" | "yearly" | null,
        trialEnd(),
      );
      if (!sameConsent(b.consent, offer)) return json({ detail: "consent_mismatch" }, 409);
      return json({ url: `https://checkout.stripe.com/c/pay/cs_test_${b.plan}` });
    }
    if (method === "POST" && (path === "/api/billing/cancel" || path === "/api/billing/resume")) {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (state.billing.plan === "free") return json({ detail: "no_subscription" }, 404);
      if (state.billing.plan === "founding") return json({ detail: "does_not_renew" }, 409);
      if (
        path.endsWith("/cancel") &&
        !(body as { consent?: { accepted?: boolean } })?.consent?.accepted
      )
        return json({ detail: "consent_required" }, 422);
      if (path.endsWith("/cancel") && !sameConsent(b.consent, cancelText()))
        return json({ detail: "consent_mismatch" }, 409);
      const cancelling = path.endsWith("/cancel");
      state.billing = {
        ...state.billing,
        cancel_at_period_end: cancelling,
        history: [
          ...(state.billing.history ?? []),
          {
            kind: cancelling ? "cancelled" : "resumed",
            plan: state.billing.plan,
            interval: state.billing.interval,
            amount_cents: null,
            until: cancelling ? state.billing.renews_at : null,
            at: new Date(Date.now() + (state.billing.history?.length ?? 0) * 1000).toISOString(),
          },
        ],
      };
      return json(billingOut());
    }
    if (method === "GET" && path === "/api/billing/history")
      return json([...(state.billing.history ?? [])].sort((a, b) => b.at.localeCompare(a.at)));
    if (method === "POST" && path === "/api/billing/portal") {
      if (state.stepUpStale) return json({ detail: "step_up_required" }, 403);
      if (!state.billing.has_customer) return json({ detail: "no_customer" }, 404);
      return json({ url: "https://billing.stripe.com/p/session/test" });
    }
    if (method === "GET" && path === "/api/groups") return json(myGroups().map(summary));
    if (method === "POST" && path === "/api/groups") {
      if (!limits?.groups_create) return json({ detail: "plan_required" }, 403);
      state.codeSeq += 1;
      const templateKey = String(b.template_key ?? "monthly_savings");
      const month = String(b.month ?? "2026-10");
      const startDate = b.start_date ? String(b.start_date) : `${month}-01`;
      const spanDays: Record<string, number> = {
        no_eat_out_week: 6,
        no_spend_weekend: 1,
        fifty_two_week: 363,
      };
      const span = spanDays[templateKey];
      const endOf = (iso: string, days: number) => {
        const d = new Date(`${iso}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };
      const g: FakeGroup = {
        id: `g${state.codeSeq}`,
        name: String(b.name),
        template_key: templateKey,
        start_date: span === undefined ? `${month}-01` : startDate,
        end_date: span === undefined ? monthEnd(month) : endOf(startDate, span),
        invite_code: `STK-NEW${state.codeSeq}`,
        owner_id: ME,
        members: [fakeMember(ME, myName(), 0, { is_owner: true })],
      };
      state.groups.push(g);
      return json(detail(g), 201);
    }
    if (method === "POST" && path === "/api/groups/lookup") {
      const g = byCode(String(b.code ?? ""));
      if (!g) return json({ detail: "not_found" }, 404);
      if (g.removed?.includes(ME)) return json({ detail: "removed" }, 403);
      if (g.ended) return json({ detail: "ended" }, 409); // invariant 56
      const owner = g.members.find((m) => m.user_id === g.owner_id);
      return json({
        id: g.id,
        name: g.name,
        template_key: g.template_key,
        started_by: owner?.display_name ?? "Former member",
        start_date: g.start_date,
        end_date: g.end_date,
        member_count: activeMembers(g).length,
        already_member: g.members.some((m) => m.user_id === ME),
      });
    }
    if (method === "POST" && path === "/api/groups/join") {
      const g = byCode(String(b.code ?? ""));
      if (!g) return json({ detail: "not_found" }, 404);
      if (g.removed?.includes(ME)) return json({ detail: "removed" }, 403);
      if (!g.members.some((m) => m.user_id === ME) && g.ended)
        return json({ detail: "ended" }, 409); // invariant 56
      if (!g.members.some((m) => m.user_id === ME)) {
        const joinMax = limits?.groups_join_max;
        if (typeof joinMax === "number" && myGroups().length >= joinMax)
          return json({ detail: "plan_limit" }, 403);
        g.members.push(fakeMember(ME, myName(), 0));
      }
      return json(detail(g));
    }
    const groupPath = path.match(/^\/api\/groups\/([^/]+)(?:\/(.+))?$/);
    if (groupPath) {
      const g = state.groups.find((x) => x.id === groupPath[1]);
      const me = g?.members.find((m) => m.user_id === ME);
      if (!g || !me) return json({ detail: "not_found" }, 404);
      const rest = groupPath[2];
      if (method === "GET" && !rest) return json(detail(g));
      if (method === "PUT" && rest === "progress") {
        me.progress_bps = Number(b.progress_bps);
        me.has_events = true;
        if (me.progress_bps >= 10000 && !me.reached_at) me.reached_at = "2026-10-10T12:00:00Z";
        return json({ ...me, is_me: true, is_owner: g.owner_id === ME });
      }
      if (method === "PUT" && rest === "helped") {
        const choices = (b.choices as unknown as string[] | undefined) ?? [];
        if (choices.length > 5) return json({ detail: "invalid_choices" }, 422);
        if (!(g.ended || me.reached_at)) return json({ detail: "not_yet" }, 409);
        g.answers = { ...(g.answers ?? {}), [ME]: choices };
        return json(detail(g));
      }
      if (method === "POST" && rest === "leave") {
        if (g.owner_id === ME) return json({ detail: "owner_cannot_leave" }, 409);
        g.members = g.members.filter((m) => m.user_id !== ME);
        return new Response(null, { status: 204 });
      }
      const removal = rest?.match(/^members\/(.+)$/);
      if (method === "DELETE" && removal) {
        if (g.owner_id !== ME) return json({ detail: "owner_only" }, 403);
        g.members = g.members.filter((m) => m.user_id !== removal[1]);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && rest === "code") {
        if (g.owner_id !== ME) return json({ detail: "owner_only" }, 403);
        state.codeSeq += 1;
        g.invite_code = `STK-NEW${state.codeSeq}`;
        return json(detail(g));
      }
    }
    return json({ detail: "not_found" }, 404);
  };
  return state;
}
