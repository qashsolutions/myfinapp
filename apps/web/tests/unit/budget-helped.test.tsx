/**
 * A budget alert in the moment (Budget's "Close" / "Over" and Alerts' "Tell me at") and "What
 * helped" in challenges (fixed choices, ids only to the server, totals only back).
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { createBudget } from "../../src/features/budget/useBudget.ts";
import {
  defaultNotifications,
  fakeMember,
  installFakeApi,
  ME,
  mayasGroup,
  readySession,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-21T12:00:00");

function spend(id: string, cents: number, category: string): Entry {
  return {
    id,
    date: "2026-10-05",
    amount_cents: cents,
    direction: "out",
    merchant: "Shop",
    clean_description: "SHOP",
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-05T10:00:00.000Z",
    updated_at: "2026-10-05T10:00:00.000Z",
  };
}

describe("Budget alert in the moment", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("zero-based lines say Close from 90% and Over past the plan", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      spend("d1", 18000, "cat-dining"), // 90% of $200
      spend("f1", 10500, "cat-fun"), // 105% of $100
      spend("g1", 10000, "cat-groceries"), // 25% of $400
    ]);
    await createBudget(db, "2026-10", "zero_based", 400000, [
      { category_id: "cat-dining", planned_cents: 20000 },
      { category_id: "cat-fun", planned_cents: 10000 },
      { category_id: "cat-groceries", planned_cents: 40000 },
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    const planned = await screen.findByRole("region", { name: "Planned by category" });
    const lineOf = (name: string) =>
      within(planned).getByRole("button", { name: `Move money to or from ${name}` })
        .parentElement as HTMLElement;
    await waitFor(() => expect(lineOf("Dining")).toHaveTextContent(/^Close/));
    expect(lineOf("Fun")).toHaveTextContent(/^Over/);
    expect(lineOf("Groceries")).not.toHaveTextContent(/Close|Over/);
  });

  it("Close follows the person's own Tell me at, the same level the alert uses", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([spend("d1", 17000, "cat-dining")]); // 85% of $200
    await createBudget(db, "2026-10", "zero_based", 400000, [
      { category_id: "cat-dining", planned_cents: 20000 },
    ]);
    const notifications = defaultNotifications();
    notifications.prefs.budget_pace = { ...notifications.prefs.budget_pace, threshold: 80 };
    installFakeApi({ session: readySession(), notifications });
    renderApp("/budget");
    const planned = await screen.findByRole("region", { name: "Planned by category" });
    const dining = () =>
      within(planned).getByRole("button", { name: "Move money to or from Dining" })
        .parentElement as HTMLElement;
    await waitFor(() => expect(dining()).toHaveTextContent(/^Close/));
  });

  it("Alerts says budget line, which fits a category and a bucket", async () => {
    installFakeApi({ session: readySession() });
    renderApp("/me/notifications");
    const list = await screen.findByRole("list", { name: "Alert types" });
    await waitFor(() => expect(list).toHaveTextContent("At 90% and 100% of a budget line's plan"));
    expect(list).not.toHaveTextContent("category's plan");
  });

  it("the bucket method reads per bucket: Wants is Close at 90% of its share", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([spend("d1", 27500, "cat-dining")]); // wants: 30% of $1,000 = $300
    await createBudget(db, "2026-10", "50_30_20", 100000);
    installFakeApi({ session: readySession() });
    renderApp("/budget");
    const wants = await screen.findByRole("region", { name: "Wants 30%" });
    await waitFor(() => expect(wants).toHaveTextContent(/^Close/));
    expect(screen.getByRole("region", { name: "Needs 50%" })).toHaveTextContent(/^Steady/);
  });

  it("Alerts: Budget alert is on, Tell me at takes 90% / 100% or your own 50 to 150", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const api = installFakeApi({ session: readySession() });
    renderApp("/me/notifications");
    const list = await screen.findByRole("list", { name: "Alert types" });
    expect(within(list).getByRole("switch", { name: "Budget alert alerts" })).toBeChecked();
    const group = within(list).getByRole("group", { name: "Budget alert options" });
    expect(within(group).getByRole("radio", { name: "90%" })).toBeChecked();
    await user.click(within(group).getByRole("radio", { name: "100%" }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.method === "PUT" &&
            JSON.stringify(c.body) ===
              JSON.stringify({ prefs: { budget_pace: { threshold: 100 } } }),
        ),
      ).toBe(true),
    );
    const own = within(group).getByLabelText("Your own percent of the plan, 50 to 150");
    await user.type(own, "160{Enter}");
    expect(await within(group).findByRole("alert")).toHaveTextContent(
      "Pick a whole percent from 50 to 150.",
    );
  });
});

describe("What helped", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a member who reached the target picks up to three; only the ids leave; totals come back", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const group = {
      ...mayasGroup(),
      id: "g-done",
      members: [fakeMember(ME, "Nia", 10000), fakeMember("u-dev", "Dev P.", 10000)],
      answers: { "u-dev": ["packed_lunch"] },
    };
    const api = installFakeApi({ session: readySession(), groups: [group] });
    renderApp("/groups/g-done");
    const card = await screen.findByRole("region", { name: "What helped" });
    expect(card).toHaveTextContent("The group's totals show once two other members have answered.");
    await user.click(within(card).getByRole("checkbox", { name: "Packed lunch" }));
    await user.click(within(card).getByRole("checkbox", { name: "Cooked at home" }));
    await user.click(within(card).getByRole("checkbox", { name: "No-spend days" }));
    expect(within(card).getByRole("checkbox", { name: "Shopped with a list" })).toBeDisabled();
    await user.click(within(card).getByRole("checkbox", { name: "No-spend days" }));
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(card).toHaveTextContent("Saved."));
    const put = api.calls.find((c) => c.method === "PUT" && c.path === "/api/groups/g-done/helped");
    expect(put?.body).toEqual({ choices: ["packed_lunch", "cooked_home"] });
    await waitFor(() => expect(card).toHaveTextContent("2 of 2 said Packed lunch"));
    expect(card).toHaveTextContent("1 of 2 said Cooked at home");
    // Nothing names who chose what
    expect(card).not.toHaveTextContent(/Dev|Nia/);
  });

  it("is not offered before the target is reached", async () => {
    installFakeApi({
      session: readySession(),
      groups: [{ ...mayasGroup(), members: [fakeMember(ME, "Nia", 4000)] }],
    });
    renderApp("/groups/g-maya");
    await screen.findByRole("list", { name: "Leaderboard" });
    expect(screen.queryByRole("region", { name: "What helped" })).toBeNull();
  });
});
