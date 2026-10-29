/**
 * Invariants 54 and 55 (October 29, 2026), on the device.
 *
 * 54. A household of two is one plan: the partner's access follows the holder's plan, so an
 *     invite opens before any trial, joining refreshes the plan at once, and the Plan screen says
 *     whose plan it is with nothing to buy.
 * 55. Shared jars travel soon: a change to one is published 2 s later (not on the next 2-minute
 *     round), and the app pulls when it returns to the foreground and every 15 s while shared
 *     jars are on screen.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { closeDb, deleteDb, openDb, seedDefaults } from "../../src/data/db.ts";
import { parseEntitlements, resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { addGoalEvent, createGoal } from "../../src/features/goals/useGoals.ts";
import {
  ensureHouseholdKey,
  rememberHousehold,
} from "../../src/features/household/householdSync.ts";
import {
  HOUSEHOLD_CLOSE_SYNC_MS,
  HOUSEHOLD_PUBLISH_DEBOUNCE_MS,
} from "../../src/features/household/useHousehold.ts";
import {
  emptyHouseholds,
  type FakeHouseholds,
  freeBilling,
  installFakeApi,
  readySession,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const HH = "hh-1";
const now = new Date().toISOString();

function householdOf(members: Array<[string, string]>, invite = true): FakeHouseholds {
  const households = emptyHouseholds();
  households.rows.push({
    id: HH,
    owner_id: members[0]?.[0] ?? "u9",
    created_at: now,
    members: members.map(([user_id, display_name]) => ({
      user_id,
      display_name,
      initial: display_name[0] ?? "?",
      joined_at: now,
      left_at: null,
    })),
    invite: invite ? { code: "HH-ABCDEF", expires_at: "2099-01-01T00:00:00Z", used: false } : null,
    blobs: [],
  });
  return households;
}

const ben = () =>
  readySession({
    user: { id: "u1", email: "ben@example.com", display_name: "Ben", look: "modern" },
  });

describe("A household is one plan (invariant 54)", () => {
  beforeEach(() => resetEntitlements());

  it("reads who holds the shared plan from the server's answer", () => {
    const base = {
      plan: "connected",
      goals_active_max: 10,
      statement_accounts_max: null,
      groups_create: true,
      groups_join_max: null,
      bank_links_max: 3,
      backup: true,
      household: true,
    };
    const covered = parseEntitlements({
      ...base,
      access: { state: "subscribed", plan: "connected", shared: "covered" },
    });
    expect(covered?.access).toMatchObject({ state: "subscribed", shared: "covered" });
    expect(covered?.access?.card_from).toBeNull(); // no card ask of their own
    const alone = parseEntitlements({
      ...base,
      access: { state: "subscribed", plan: "connected" },
    });
    expect(alone?.access?.shared).toBeNull();
  });

  it("an invite opens before any trial, and joining covers the partner at once", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: ben(),
      billing: freeBilling(),
      households: householdOf([["u9", "Asha"]]),
    });
    api.access = { state: "choose", plan: "free", trial_used: false };
    const key = "a".repeat(43);
    renderApp(`/household/join?code=HH-ABCDEF#k=${key}`);
    // Not sent to /start: the household's plan is the way in.
    expect(await screen.findByText(/invited you to share a household/)).toHaveTextContent("Asha");
    expect(screen.getByText(/One price covers both of you/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Join Asha's household" }));
    await screen.findByRole("heading", { level: 1, name: "Couples & household" });
    // The plan was asked for again after joining, and the app opens to it.
    const asked = api.calls.filter((c) => c.path === "/api/billing/entitlements").length;
    expect(asked).toBeGreaterThanOrEqual(2);

    await user.click(await screen.findByRole("link", { name: "Me" }));
    renderApp("/me/plan");
    const current = await screen.findAllByRole("region", { name: "Current plan" });
    await waitFor(() =>
      expect(current.at(-1)).toHaveTextContent("Shared with Asha · one price covers you both"),
    );
    expect(
      (await screen.findAllByRole("region", { name: "Shared plan" })).at(-1),
    ).toHaveTextContent("nothing to buy");
    expect(screen.queryByRole("heading", { name: "Choose a plan" })).not.toBeInTheDocument();
  });

  it("the holder is told the plan covers both", async () => {
    const billing = { ...freeBilling(), plan: "connected" as const, shared: "holder" as const };
    const api = installFakeApi({ session: ben(), billing });
    api.access = { state: "subscribed", plan: "connected", shared: "holder" };
    renderApp("/me/plan");
    const card = await screen.findByRole("region", { name: "Current plan" });
    await waitFor(() =>
      expect(card).toHaveTextContent("This plan covers you and your partner in your household"),
    );
  });

  it("a holder whose plan ended is never told it still covers both (invariant 67)", async () => {
    const billing = { ...freeBilling(), shared: "holder" as const };
    const api = installFakeApi({ session: ben(), billing });
    api.access = {
      state: "lapsed",
      plan: "free",
      shared: "holder",
      ended_at: "2026-10-28T12:00:00Z",
      delete_at: "2026-11-04T12:00:00Z",
    };
    renderApp("/me/plan");
    const card = await screen.findByRole("region", { name: "Current plan" });
    await waitFor(() => expect(card).toHaveTextContent("It ended for both of you"));
    expect(card).not.toHaveTextContent("This plan covers you and your partner");
  });
});

describe("Shared jars travel soon (invariant 55)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    closeDb("u1");
    await deleteDb("u1");
  });

  async function sharedJar() {
    const db = openDb("u1");
    await seedDefaults(db);
    await rememberHousehold(db, HH);
    await ensureHouseholdKey(db);
    return createGoal(db, {
      kind: "save",
      title: "Trip",
      target_cents: 100000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      household_id: HH,
    });
  }

  const puts = (api: ReturnType<typeof installFakeApi>) =>
    api.calls.filter((c) => c.method === "PUT" && c.path === "/api/household/blobs/jars").length;
  const pulls = (api: ReturnType<typeof installFakeApi>) =>
    api.calls.filter((c) => c.method === "GET" && c.path === "/api/household/blobs").length;

  it("a deposit into a shared jar is published within seconds, once for a burst", async () => {
    const jar = await sharedJar();
    const api = installFakeApi({
      session: ben(),
      billing: { ...freeBilling(), plan: "connected" },
      households: householdOf(
        [
          ["u9", "Asha"],
          ["u1", "Ben"],
        ],
        false,
      ),
    });
    renderApp(`/goals/${jar.id}`);
    await screen.findByRole("heading", { level: 1, name: "Trip" });
    await waitFor(() => expect(puts(api)).toBe(1)); // the round on open
    const db = openDb("u1");
    await addGoalEvent(db, jar.id, "deposit", "2026-10-05", 5000, new Date(), "u1");
    await addGoalEvent(db, jar.id, "deposit", "2026-10-05", 2500, new Date(), "u1");
    await waitFor(() => expect(puts(api)).toBe(2), {
      timeout: HOUSEHOLD_PUBLISH_DEBOUNCE_MS + 2000,
    });
    await new Promise((r) => setTimeout(r, HOUSEHOLD_PUBLISH_DEBOUNCE_MS + 300));
    expect(puts(api)).toBe(2); // the two deposits went together
  }, 15000);

  it("pulls on coming back to the foreground and every 15 s while a shared jar is open", async () => {
    // The shell's 15 s tick, caught so the test can run it (IndexedDB and waitFor need real timers).
    const ticks: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === HOUSEHOLD_CLOSE_SYNC_MS) ticks.push(fn);
      return realSetInterval(fn, ms);
    }) as typeof setInterval);
    const jar = await sharedJar();
    const api = installFakeApi({
      session: ben(),
      billing: { ...freeBilling(), plan: "connected" },
      households: householdOf(
        [
          ["u9", "Asha"],
          ["u1", "Ben"],
        ],
        false,
      ),
    });
    renderApp(`/goals/${jar.id}`);
    await screen.findByRole("heading", { level: 1, name: "Trip" });
    await waitFor(() => expect(puts(api)).toBe(1)); // the round on open has finished
    expect(pulls(api)).toBe(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(pulls(api)).toBe(2));
    await new Promise((r) => setTimeout(r, 200)); // that round finishes
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) tick(); // 15 s later, with the shared jar still open
    await waitFor(() => expect(pulls(api)).toBe(3));
    vi.restoreAllMocks();
  }, 15000);
});
