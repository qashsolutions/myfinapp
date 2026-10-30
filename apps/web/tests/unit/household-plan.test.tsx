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
  privateBilling,
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

describe("Paying for a plan of one's own in a household (owner decision, October 29, 2026)", () => {
  beforeEach(() => resetEntitlements());

  function paysPrivate() {
    const api = installFakeApi({
      session: ben(),
      billing: { ...privateBilling(), interval: "monthly", source: "stripe" },
      households: householdOf([["u9", "Asha"]]),
    });
    api.access = { state: "subscribed", plan: "private" };
    return api;
  }

  it("asks before joining, and Stop mine opens the usual cancel sheet", async () => {
    const user = userEvent.setup();
    const api = paysPrivate();
    renderApp(`/household/join?code=HH-ABCDEF#k=${"a".repeat(43)}`);
    expect(
      await screen.findByText(
        "You pay for Private yourself. In a household one plan covers you both. Stop yours at the end of its paid period?",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join Asha's household" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop mine" }));
    expect(await screen.findByRole("dialog", { name: "If you cancel" })).toBeInTheDocument();
    // Nothing stopped until the tick and the tap in that sheet.
    expect(api.calls.some((c) => c.path === "/api/billing/cancel")).toBe(false);
  });

  it("Keep mine joins and stops nothing", async () => {
    const user = userEvent.setup();
    const api = paysPrivate();
    renderApp(`/household/join?code=HH-ABCDEF#k=${"a".repeat(43)}`);
    await user.click(await screen.findByRole("button", { name: "Keep mine" }));
    await screen.findByRole("heading", { level: 1, name: "Couples & household" });
    expect(api.calls.some((c) => c.path === "/api/household/join")).toBe(true);
    expect(api.calls.some((c) => c.path.startsWith("/api/billing/cancel"))).toBe(false);
  });

  it("a store plan is stopped in the store", async () => {
    const api = installFakeApi({
      session: ben(),
      billing: { ...privateBilling(), source: "apple" },
      households: householdOf([["u9", "Asha"]]),
    });
    api.access = { state: "subscribed", plan: "private" };
    renderApp(`/household/join?code=HH-ABCDEF#k=${"a".repeat(43)}`);
    expect(
      await screen.findByText("You bought it in the App Store, so you stop it there."),
    ).toBeInTheDocument();
  });

  it("a Connected joiner is not asked, and once covered can stop theirs", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: ben(),
      billing: { ...privateBilling(), plan: "connected", source: "stripe" },
      households: householdOf([["u9", "Asha"]]),
    });
    api.access = { state: "subscribed", plan: "connected" };
    renderApp(`/household/join?code=HH-ABCDEF#k=${"a".repeat(43)}`);
    expect(await screen.findByRole("button", { name: "Join Asha's household" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop mine" })).toBeNull();
    api.billing = {
      ...api.billing,
      shared: "covered",
      shared_by: "Asha",
      own_plan: "connected",
      renews_at: "2026-11-20T12:00:00Z",
    };
    api.access = { state: "subscribed", plan: "connected", shared: "covered" };
    renderApp("/me/plan");
    const card = (await screen.findAllByRole("region", { name: "Current plan" })).at(-1);
    await waitFor(() => expect(card).toHaveTextContent("You also pay for Connected"));
    await user.click(screen.getByRole("button", { name: "Stop my Connected" }));
    expect(await screen.findByRole("dialog", { name: "If you cancel" })).toBeInTheDocument();
  });

  it("the Plan screen says the household covers them and offers to stop their own", async () => {
    const user = userEvent.setup();
    const billing = {
      ...privateBilling(),
      plan: "connected" as const,
      interval: "monthly" as const,
      source: "stripe" as const,
      renews_at: "2026-11-20T12:00:00Z",
      shared: "covered" as const,
      shared_by: "Asha",
      own_plan: "private" as const,
    };
    const api = installFakeApi({ session: ben(), billing });
    api.access = { state: "subscribed", plan: "connected", shared: "covered" };
    renderApp("/me/plan");
    const card = await screen.findByRole("region", { name: "Current plan" });
    await waitFor(() =>
      expect(card).toHaveTextContent(
        "Covered by Asha's Connected. You also pay for Private (renews Nov 20, 2026) — you can stop it.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Stop my Private" }));
    expect(await screen.findByRole("dialog", { name: "If you cancel" })).toBeInTheDocument();
  });
});

describe("The leave sheet says what each person keeps (invariant 67)", () => {
  beforeEach(() => resetEntitlements());

  it("shows the server's outcome for each of the two", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: ben(),
      billing: freeBilling(),
      households: householdOf([
        ["u9", "Asha"],
        ["u1", "Ben"],
      ]),
    });
    api.householdLeavePreview = [
      {
        user_id: "u9",
        name: "Asha",
        is_me: false,
        outcome: "keeps",
        plan: "connected",
        until: null,
      },
      {
        user_id: "u1",
        name: "Ben",
        is_me: true,
        outcome: "own_plan",
        plan: "private",
        until: null,
      },
    ];
    renderApp("/me/household");
    await user.click(await screen.findByRole("button", { name: "Leave household" }));
    expect(await screen.findByText("Asha keeps Connected.")).toBeInTheDocument();
    expect(screen.getByText("You go back to your own Private.")).toBeInTheDocument();
    expect(screen.queryByText(/the other has 7 days/)).toBeNull();
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
