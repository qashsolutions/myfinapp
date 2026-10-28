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
