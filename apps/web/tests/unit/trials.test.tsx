import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { accessRoutes } from "../../src/app/AccessGate.tsx";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { type Access, resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { emailHash, keptAccount, rememberKept } from "../../src/lib/keptAccount.ts";
import { installFakeApi, readySession, signedOut } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Trials instead of a lasting Free plan (owner decision, October 14, 2026). */
describe("trials", () => {
  it("a new account picks its free trial first, with no card, then makes Qash its own", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free" };
    renderApp("/budget");
    expect(await screen.findByRole("heading", { name: "Try Qash free" })).toBeInTheDocument();
    // 3 days on either plan (owner decision, October 22, 2026)
    expect(await screen.findAllByText("Free for 3 days")).toHaveLength(2);
    expect(screen.getByRole("list", { name: "How the free trial works" })).toHaveTextContent(
      "We send a friendly reminder the day before it ends.",
    );
    // How the trial works, up front (October 20, 2026)
    const how = screen.getByRole("list", { name: "How the free trial works" });
    expect(how).toHaveTextContent("No card needed, and nothing is charged during the trial.");
    expect(how).toHaveTextContent("What's on your device stays there until you decide.");
    await user.click(screen.getByRole("radio", { name: /Connected/ }));
    await user.click(screen.getByRole("button", { name: "Start my 3-day free trial" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === "/api/billing/trial")?.body).toEqual({
        plan: "connected",
      }),
    );
    // Then "Make Qash yours": choices, any order, all optional
    expect(
      await screen.findByRole("heading", { level: 1, name: "Make Qash yours" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Add your money/ })).toHaveAttribute(
      "href",
      "/import",
    );
    await user.click(screen.getByRole("button", { name: "Done for now" }));
    expect(await screen.findByText("Connected trial · 3 days left")).toBeInTheDocument();
    expect(screen.getByText(/No card needed yet/)).toBeInTheDocument();
  });

  it("near the end the trial card asks for a card, charged only when the trial ends", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.billing = { ...api.billing, plan: "private" };
    api.access = {
      state: "trial",
      plan: "private",
      days: 45,
      trial_ends_at: iso(3 * DAY),
      card_from: iso(-3 * DAY),
    };
    renderApp("/");
    expect(await screen.findByText("Private trial · 3 days left")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Add a card" }));
    const priv = await screen.findByRole("article", { name: "Private" });
    // A trial has nothing to cancel and no receipts yet.
    expect(screen.queryByText("Cancel plan")).toBeNull();
    expect(screen.getByRole("region", { name: "Current plan" })).toHaveTextContent("Private trial");
    await user.click(within(priv).getByRole("button", { name: "Choose Private" }));
    const sheet = await screen.findByRole("dialog", { name: "Before you subscribe" });
    expect(sheet).toHaveTextContent(/Free until .+, then \$20\.00 every year\./);
  });

  it("Me shows a trial as a trial, never as a price", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.billing = { ...api.billing, plan: "private" };
    api.access = {
      state: "trial",
      plan: "private",
      days: 45,
      trial_ends_at: "2026-11-28T12:00:00Z",
      card_from: "2026-11-22T12:00:00Z",
    };
    renderApp("/me");
    const row = await screen.findByRole("link", { name: /Private trial/ });
    expect(row).toHaveTextContent("Free trial until Nov 28, 2026");
    expect(row).not.toHaveTextContent("$");
    expect(row).toHaveAttribute("href", "/me/account");
  });

  it("yearly shows how much it saves against paying monthly", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/me/plan");
    const priv = await screen.findByRole("article", { name: "Private" });
    const conn = screen.getByRole("article", { name: "Connected" });
    expect(priv).toHaveTextContent("Save 44%");
    expect(conn).toHaveTextContent("Save 23%");
    expect(screen.queryByRole("article", { name: "Free" })).toBeNull(); // no lasting Free plan
    await user.click(screen.getByRole("radio", { name: "Monthly" }));
    expect(priv).not.toHaveTextContent("Save 44%");
  });

  it("when a plan has ended, only subscribing, exporting or deleting is open", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = {
      state: "lapsed",
      plan: "free",
      ended_at: iso(-DAY),
      delete_at: iso(6 * DAY),
    };
    renderApp("/budget");
    const alert = await screen.findByRole("alert");
    // A friendly update, not a warning (owner, October 20, 2026)
    expect(alert).toHaveTextContent("Your trial has wrapped up");
    expect(alert).toHaveTextContent(/what's on this device stays here until you decide/);
    expect(within(alert).getByRole("link", { name: "Download my data" })).toHaveAttribute(
      "href",
      "/me/data",
    );
  });

  it("a disputed payment pauses the plan: told plainly, data kept, nothing else open", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "paused", plan: "free" };
    renderApp("/budget");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your plan is paused");
    expect(alert).toHaveTextContent(/Nothing is deleted/);
    expect(within(alert).getByRole("link", { name: "Download my data" })).toBeInTheDocument();
    expect(screen.getByText("Paused while a payment is disputed")).toBeInTheDocument();
  });

  it("a lost dispute ends the plan: said plainly, account kept open, no plan offered", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "ended", plan: "free" };
    renderApp("/budget");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your plan has ended");
    expect(alert).toHaveTextContent(/Nothing is deleted: your account stays open/);
    expect(alert).not.toHaveTextContent(/comes back/);
    expect(within(alert).getByRole("link", { name: "Download my data" })).toBeInTheDocument();
    expect(screen.getByText("Ended · your bank returned the payment")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Choose a plan" })).toBeNull();
  });

  it("a bank payment still clearing says so on the Plan screen", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.billing = { ...api.billing, payment_pending: true };
    renderApp("/me/plan");
    expect(await screen.findByText("Your bank payment is on its way")).toBeInTheDocument();
    expect(screen.getByText(/up to 4 business days to clear/)).toBeInTheDocument();
  });

  it("a device whose account was deleted elsewhere erases what it kept", async () => {
    localStorage.setItem("stackd.entitlements.u1", "{}");
    localStorage.setItem("stackd.last_account", "{}");
    installFakeApi({
      session: { ...signedOut(), deleted_user_id: "u1", deleted_reason: "requested" },
    });
    renderApp("/welcome");
    await waitFor(() => expect(localStorage.getItem("stackd.last_account")).toBeNull());
    expect(localStorage.getItem("stackd.entitlements.u1")).toBeNull();
  });

  it("a plan that ended keeps the data on the phone until the person decides", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(oneEntry());
    localStorage.setItem("qash.account_hash", JSON.stringify({ user_id: "u1", hash: "h1" }));
    installFakeApi({
      session: { ...signedOut(), deleted_user_id: "u1", deleted_reason: "plan_ended" },
    });
    renderApp("/welcome");
    // Remembered under its own key, with the email hash recorded while signed in
    await waitFor(() => expect(keptAccount()?.user_id).toBe("u1"));
    expect(keptAccount()?.email_hash).toBe("h1");
    expect(await db.entries.count()).toBe(1); // nothing erased

    renderApp("/kept");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your data is safe here" }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/including 1 entry/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Erase it from this device" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Erase from this device?" })).getByRole(
        "button",
        { name: "Erase it" },
      ),
    );
    await waitFor(() => expect(keptAccount()).toBeNull());
  });

  it("signing up again with the same email offers to bring the data back", async () => {
    const user = userEvent.setup();
    const old = openDb("old-1");
    await seedDefaults(old);
    await old.entries.add(oneEntry());
    // The same email: its hash matches what the app records for the new account on sign-in.
    const same = await emailHash(readySession().user?.email ?? "");
    rememberKept({ user_id: "old-1", closed_at: "2026-10-10T00:00:00Z", email_hash: same });
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/");
    const offer = await screen.findByRole("dialog", { name: "Bring back your data?" });
    await user.click(within(offer).getByRole("button", { name: "Yes, bring it back" }));
    expect(await screen.findByRole("dialog", { name: "Welcome back" })).toBeInTheDocument();
    expect(await db.entries.get("kept-e1")).toBeTruthy();
    expect(keptAccount()).toBeNull();
  });

  it("a returning person whose trial was used sees the plans and can reach checkout", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    // Signed up again with an inbox that already had its free trial (the server says so).
    api.access = { state: "choose", plan: "free", trial_used: true };
    api.billing = {
      ...api.billing,
      plan: "free",
      interval: null,
      status: null,
      renews_at: null,
      has_customer: false,
    };
    renderApp("/budget");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Welcome back" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your free trial was already used on this email/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /free trial/ })).toBeNull();
    await user.click(screen.getByRole("link", { name: "See plans" }));
    const priv = await screen.findByRole("article", { name: "Private" });
    // No lasting Free plan: the current plan card says what is true, never "Free".
    const current = screen.getByRole("region", { name: "Current plan" });
    expect(current).toHaveTextContent("No plan yet");
    expect(current).toHaveTextContent("Your free trial was already used on this email.");
    expect(current).not.toHaveTextContent(/Free/);
    await user.click(within(priv).getByRole("button", { name: "Choose Private" }));
    const sheet = await screen.findByRole("dialog", { name: "Before you subscribe" });
    await user.click(within(sheet).getByRole("checkbox"));
    await user.click(within(sheet).getByRole("button", { name: "Continue to secure payment" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === "/api/billing/checkout")?.body).toMatchObject({
        plan: "private",
      }),
    );
  });

  it("a returning person can still download or delete, and nothing else opens", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free", trial_used: true };
    renderApp("/me/data");
    expect(await screen.findByRole("button", { name: /Download/ })).toBeInTheDocument();
    renderApp("/me/delete");
    expect(await screen.findByRole("heading", { level: 1, name: /Delete/ })).toBeInTheDocument();
    renderApp("/goals");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Welcome back" }),
    ).toBeInTheDocument();
  });

  it("a new account that doesn't want a trial can still delete itself from /start", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free" };
    renderApp("/start");
    await user.click(await screen.findByRole("link", { name: "delete your account" }));
    expect(await screen.findByRole("heading", { level: 1, name: /Delete/ })).toBeInTheDocument();
  });

  it("every access state reaches what it may: subscribe, export, delete, and nothing else", () => {
    const base = { plan: "free" as const, trial_ends_at: null, days: null, card_from: null };
    const make = (state: Access["state"], trial_used = false): Access => ({
      ...base,
      state,
      delete_at: null,
      trial_used,
      shared: null,
    });
    const routes = [
      "/",
      "/budget",
      "/start",
      "/me",
      "/me/plan",
      "/me/data",
      "/me/delete",
      "/household/join",
    ];
    const where = (a: Access | null) =>
      Object.fromEntries(
        routes.map((r) => {
          const g = accessRoutes(a);
          return [r, g === null || g.open.has(r) ? "open" : `→ ${g.home}`];
        }),
      );
    // choose: only the trial, logging out and deleting (no plan to buy before the trial)
    expect(where(make("choose"))).toEqual({
      "/": "→ /start",
      "/budget": "→ /start",
      "/start": "open",
      "/me": "open",
      "/me/plan": "→ /start",
      "/me/data": "open",
      "/me/delete": "open",
      // Invariant 54: a household's plan covers the partner, so an invite opens before a trial.
      "/household/join": "open",
    });
    // choose with the trial used, lapsed, paused, ended: the plan, export and delete
    const noPlan = {
      "/": "→ /me/plan",
      "/budget": "→ /me/plan",
      "/start": "→ /me/plan",
      "/me": "open",
      "/me/plan": "open",
      "/me/data": "open",
      "/me/delete": "open",
      "/household/join": "open",
    };
    expect(where(make("choose", true))).toEqual({
      ...noPlan,
      "/": "→ /start",
      "/budget": "→ /start",
      "/start": "open",
    });
    for (const s of ["lapsed", "paused", "ended"] as const) expect(where(make(s))).toEqual(noPlan);
    // trial and subscribed: everything (the gate sends /start home separately)
    for (const s of ["trial", "subscribed"] as const)
      expect(Object.values(where(make(s))).every((v) => v === "open")).toBe(true);
    expect(accessRoutes(null)).toBeNull(); // the server hasn't said: never locked out
  });

  it("a trial already used is said plainly when the server answers trial_used", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free" };
    renderApp("/start");
    const start = await screen.findByRole("button", { name: "Start my 3-day free trial" });
    // Claimed on another device in between: the server now answers 409 trial_used.
    api.access = { state: "choose", plan: "free", trial_used: true };
    await user.click(start);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Welcome back" }),
    ).toBeInTheDocument();
  });

  it("signing up again after a plan ended offers the data back before any plan is bought", async () => {
    resetEntitlements();
    const user = userEvent.setup();
    const old = openDb("old-1");
    await seedDefaults(old);
    await old.entries.add(oneEntry());
    const same = await emailHash(readySession().user?.email ?? "");
    rememberKept({ user_id: "old-1", closed_at: "2026-10-10T00:00:00Z", email_hash: same });
    const db = openDb("u1");
    await seedDefaults(db);
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "choose", plan: "free", trial_used: true };
    renderApp("/");
    const offer = await screen.findByRole("dialog", { name: "Bring back your data?" });
    await user.click(within(offer).getByRole("button", { name: "Yes, bring it back" }));
    expect(await screen.findByRole("dialog", { name: "Welcome back" })).toBeInTheDocument();
    expect(await db.entries.get("kept-e1")).toBeTruthy();
    expect(keptAccount()).toBeNull();
  });

  it("someone else signing up on that phone is never offered it", async () => {
    rememberKept({ user_id: "old-1", closed_at: "2026-10-10T00:00:00Z", email_hash: "theirs" });
    localStorage.setItem("qash.account_hash", JSON.stringify({ user_id: "u1", hash: "mine" }));
    await seedDefaults(openDb("u1"));
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("navigation", { name: "Primary" });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("dialog", { name: "Bring back your data?" })).toBeNull();
  });
});

function oneEntry() {
  return {
    id: "kept-e1",
    date: "2026-10-01",
    amount_cents: 1200,
    direction: "out" as const,
    merchant: "Corner Market",
    clean_description: "CORNER MARKET",
    raw_description: null,
    category_id: null,
    account_id: "acct-cash",
    source: "manual" as const,
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}
