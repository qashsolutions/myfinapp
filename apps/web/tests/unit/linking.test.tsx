import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/data/db.ts";
import { billingState } from "../../src/features/billing/billing.ts";
import { attachAccounts } from "../../src/features/linking/linking.ts";
import { installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const connectedBilling = () => ({ ...privateBilling(), plan: "connected" as const });

const PLATYPUS = {
  institution_name: "First Platypus Bank",
  accounts: [
    {
      account_id: "acc-chk",
      name: "Plaid Checking",
      mask: "0000",
      type: "depository",
      subtype: "checking",
    },
    {
      account_id: "acc-cc",
      name: "Plaid Credit Card",
      mask: "3333",
      type: "credit",
      subtype: "credit card",
    },
    { account_id: "acc-ira", name: "Plaid IRA", mask: "5555", type: "investment", subtype: "ira" },
  ],
};

describe("linked banks & cards (chunk 3.2)", () => {
  beforeEach(() => {
    billingState.lastUrl = null;
  });

  it("asks for the passkey, then sends the browser to the provider's page", async () => {
    const api = installFakeApi({
      session: readySession({ passkey_verified_at: "2026-01-01T00:00:00Z" }),
      billing: connectedBilling(),
    });
    api.stepUpStale = true;
    renderApp("/me/linking");
    expect(await screen.findByRole("heading", { name: "Linked banks & cards" })).toBeTruthy();
    expect(screen.getByText(/can never move money/)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Connect a bank or card" }));
    expect(await screen.findByText(/Linking a bank or card needs a quick check/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Confirm with/ }));
    await waitFor(() => expect(billingState.lastUrl).toBe("https://hosted.plaid.com/link/ls1"));
    const start = api.calls.find((c) => c.path === "/api/linking/start");
    expect(start?.body ?? {}).toEqual({});
  });

  it("finishes on return: checking and card become device accounts, the rest is skipped", async () => {
    const api = installFakeApi({ session: readySession(), billing: connectedBilling() });
    api.linking.sessions.push("ls9");
    api.linking.nextLink = [PLATYPUS];
    renderApp("/me/linking/done?session=ls9");
    expect(await screen.findByText("First Platypus Bank is linked.")).toBeTruthy();
    expect(screen.getByText("Plaid Checking ••0000")).toBeTruthy();
    expect(screen.getByText("Plaid Credit Card ••3333")).toBeTruthy();
    expect(screen.getByText(/Not used: Plaid IRA/)).toBeTruthy();
    const accounts = await openDb("u1").accounts.toArray();
    const linked = accounts.filter((a) => a.linked);
    expect(linked.map((a) => [a.type, a.last4, a.institution]).sort()).toEqual([
      ["checking", "0000", "First Platypus Bank"],
      ["credit_card", "3333", "First Platypus Bank"],
    ]);
    const finish = api.calls.filter((c) => c.path === "/api/linking/finish");
    expect(finish).toHaveLength(1);
    expect(finish[0]?.body).toEqual({ session_id: "ls9" });
  });

  it("says so when the user left without linking", async () => {
    const api = installFakeApi({ session: readySession(), billing: connectedBilling() });
    api.linking.sessions.push("ls9");
    renderApp("/me/linking/done?session=ls9");
    expect(await screen.findByText(/Nothing was linked/)).toBeTruthy();
  });

  it("says a bank is already linked instead of linking it twice", async () => {
    const api = installFakeApi({ session: readySession(), billing: connectedBilling() });
    api.linking.connections.push({
      id: "bc1",
      institution_name: "First Platypus Bank",
      created_at: "2026-10-01T12:00:00Z",
      status: "ok",
      updates_available: false,
      last_synced_at: null,
    });
    api.linking.sessions.push("ls9");
    api.linking.nextLink = [{ institution_name: "First Platypus Bank", accounts: [] }];
    renderApp("/me/linking/done?session=ls9");
    expect(await screen.findByText(/First Platypus Bank is already linked/)).toBeTruthy();
    expect(screen.getByText(/tap Sign in again on it/)).toBeTruthy();
    expect(api.linking.connections).toHaveLength(1);
  });

  it("names a bank whose accounts couldn't be read, and keeps the others", async () => {
    const api = installFakeApi({ session: readySession(), billing: connectedBilling() });
    api.linking.sessions.push("ls9");
    api.linking.nextLink = [
      PLATYPUS,
      { institution_name: "Second Bank", accounts: [], failed: true },
    ];
    renderApp("/me/linking/done?session=ls9");
    expect(await screen.findByText("First Platypus Bank is linked.")).toBeTruthy();
    expect(
      screen.getByText(/Second Bank couldn't be read just now, so it wasn't linked/),
    ).toBeTruthy();
    expect(api.linking.connections.map((c) => c.institution_name)).toEqual(["First Platypus Bank"]);
  });

  it("adopts an account the user already imported into, so entries share one account", async () => {
    installFakeApi({ session: readySession() });
    const db = openDb("u1");
    await db.accounts.add({
      id: "mine",
      label: "My checking",
      type: "checking",
      last4: "0000",
      institution: null,
      currency: "USD",
      created_at: "2026-09-01T00:00:00Z",
    });
    const { used } = await attachAccounts(db, [
      {
        id: "bc1",
        institution_name: "First Platypus Bank",
        created_at: "",
        status: "ok",
        updates_available: false,
        new_accounts: false,
        accounts: PLATYPUS.accounts,
      },
    ]);
    expect(used.map((a) => a.id)).toContain("mine");
    const mine = await db.accounts.get("mine");
    expect(mine?.linked).toEqual({ connection_id: "bc1", account_id: "acc-chk" });
    expect(mine?.label).toBe("My checking");
    // Linking again does not duplicate.
    await attachAccounts(db, [
      {
        id: "bc1",
        institution_name: "First Platypus Bank",
        created_at: "",
        status: "ok",
        updates_available: false,
        new_accounts: false,
        accounts: PLATYPUS.accounts,
      },
    ]);
    expect((await db.accounts.toArray()).filter((a) => a.linked)).toHaveLength(2);
  });

  it("disconnects in one confirmation and keeps the accounts", async () => {
    const api = installFakeApi({ session: readySession(), billing: connectedBilling() });
    api.linking.sessions.push("ls9");
    api.linking.nextLink = [PLATYPUS];
    renderApp("/me/linking/done?session=ls9");
    await screen.findByText("First Platypus Bank is linked.");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await act(async () => {
      await userEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }),
      );
    });
    expect(await screen.findByText(/First Platypus Bank is disconnected/)).toBeTruthy();
    expect(api.linking.connections).toEqual([]);
    const accounts = await openDb("u1").accounts.toArray();
    expect(accounts.filter((a) => a.last4 === "0000" || a.last4 === "3333")).toHaveLength(2);
    expect(accounts.every((a) => !a.linked)).toBe(true);
  });

  it("shows the plan limit on Free and the off state when the server has no provider", async () => {
    installFakeApi({ session: readySession() }); // private: bank_links_max 0
    renderApp("/me/linking");
    expect(await screen.findByText(/comes with Connected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect a bank or card" })).toBeNull();
  });
});

describe("new accounts at a linked bank (invariant 96)", () => {
  beforeEach(() => {
    billingState.lastUrl = null;
  });

  const NEW_CARD = {
    account_id: "acc-new",
    name: "Plaid Rewards Card",
    mask: "4444",
    type: "credit",
    subtype: "credit card",
  };

  function withBank(newAccounts: boolean, status = "ok") {
    const api = installFakeApi({
      session: readySession({ passkey_verified_at: "2026-01-01T00:00:00Z" }),
      billing: connectedBilling(),
    });
    api.linking.connections.push({
      id: "bc1",
      institution_name: "First Platypus Bank",
      created_at: "2026-10-01T12:00:00Z",
      status,
      updates_available: false,
      last_synced_at: null,
      new_accounts: newAccounts,
    });
    return api;
  }

  const offer = () => screen.findByRole("group", { name: "New accounts at First Platypus Bank" });
  const callsTo = (api: ReturnType<typeof withBank>, end: string) =>
    api.calls.filter((c) => c.path.endsWith(end));

  it("offers them, asks for the passkey, then opens Plaid on the same bank", async () => {
    const api = withBank(true);
    api.stepUpStale = true;
    renderApp("/me/linking");
    const card = await offer();
    expect(within(card).getByText("Found")).toBeTruthy();
    expect(within(card).getByText(/Pick which ones Qash can read/)).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Add them" }));
    expect(await screen.findByText(/Sharing more accounts needs a quick check/)).toBeTruthy();
    api.stepUpStale = false;
    await userEvent.click(screen.getByRole("button", { name: /^Confirm with/ }));
    await waitFor(() => expect(billingState.lastUrl).toBe("https://hosted.plaid.com/link/la1"));
    expect(callsTo(api, "/start")).toHaveLength(0); // never a second connection
  });

  it("cancelling the passkey check opens nothing", async () => {
    const api = withBank(true);
    api.stepUpStale = true;
    renderApp("/me/linking");
    await userEvent.click(within(await offer()).getByRole("button", { name: "Add them" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(callsTo(api, "/add-accounts")).toHaveLength(0);
    expect(billingState.lastUrl).toBeNull();
    expect(await offer()).toBeTruthy(); // still offered
  });

  it("Not now hides the offer without opening Plaid", async () => {
    const api = withBank(true);
    renderApp("/me/linking");
    await userEvent.click(within(await offer()).getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: /New accounts at/ })).toBeNull(),
    );
    expect(callsTo(api, "/new-accounts/dismiss")).toHaveLength(1);
    expect(callsTo(api, "/add-accounts")).toHaveLength(0);
    expect(billingState.lastUrl).toBeNull();
  });

  it("offers nothing when the bank has nothing new", async () => {
    withBank(false);
    renderApp("/me/linking");
    expect(await screen.findByText("First Platypus Bank")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /New accounts at/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add them" })).toBeNull();
  });

  it("on return, the new card joins this device and nothing is duplicated", async () => {
    const api = withBank(true);
    api.linking.addAccounts = [...PLATYPUS.accounts, NEW_CARD];
    const db = openDb("u1");
    await attachAccounts(db, [
      {
        id: "bc1",
        institution_name: "First Platypus Bank",
        created_at: "",
        status: "ok",
        updates_available: false,
        new_accounts: true,
        accounts: PLATYPUS.accounts,
      },
    ]);
    api.linking.adds.la7 = "bc1";
    renderApp("/me/linking/done?session=la7");
    expect(await screen.findByText("First Platypus Bank is linked.")).toBeTruthy();
    await waitFor(async () => {
      const linked = (await db.accounts.toArray()).filter((a) => a.linked);
      expect(linked.map((a) => a.last4).sort()).toEqual(["0000", "3333", "4444"]);
    });
    expect(api.linking.connections).toHaveLength(1);
    expect(api.linking.connections[0]?.new_accounts).toBe(false);
  });

  it("leaving Plaid's page links nothing and keeps the offer", async () => {
    const api = withBank(true);
    api.linking.addExited = true;
    api.linking.adds.la7 = "bc1";
    renderApp("/me/linking/done?session=la7");
    expect(await screen.findByText(/Nothing was linked/)).toBeTruthy();
    expect(api.linking.connections[0]?.new_accounts).toBe(true);
    expect((await openDb("u1").accounts.toArray()).filter((a) => a.linked)).toHaveLength(0);
  });

  it("says what to do when the bank withdrew access meanwhile", async () => {
    const api = withBank(true);
    renderApp("/me/linking");
    const card = await offer();
    const conn = api.linking.connections[0];
    if (conn) conn.status = "revoked"; // withdrawn at the bank after the screen loaded
    await userEvent.click(within(card).getByRole("button", { name: "Add them" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Confirm with/ }));
    expect(await screen.findByText(/Access was withdrawn at the bank. Disconnect it/)).toBeTruthy();
    expect(billingState.lastUrl).toBeNull();
  });

  it("never sends an account, amount or merchant to open the offer", async () => {
    const api = withBank(true);
    renderApp("/me/linking");
    await userEvent.click(within(await offer()).getByRole("button", { name: "Add them" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Confirm with/ }));
    await waitFor(() => expect(billingState.lastUrl).not.toBeNull());
    for (const call of callsTo(api, "/add-accounts")) expect(call.raw).toBe("");
  });
});
