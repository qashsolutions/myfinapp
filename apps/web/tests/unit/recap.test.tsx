import { RULES_VERSION } from "@stackd/rules";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function entry(
  id: string,
  date: string,
  cents: number,
  merchant: string,
  direction: "in" | "out" = "out",
  category = direction === "out" ? "cat-groceries" : "cat-paycheck",
  isTransfer = false,
): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: isTransfer ? null : category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: isTransfer,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
  };
}

describe("Weekly recap", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    installFakeApi({ session: readySession() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sums the last 7 days on the device, compares with the week before, and lists jar deposits", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("e-prev", "2026-10-02", 9999, "Last week", "out", "cat-dining"), // the week before
      entry("e-pay", "2026-10-04", 150000, "Paycheck", "in"), // first day of the week
      entry("e-groc", "2026-10-06", 4217, "Corner Market"),
      entry("e-dine", "2026-10-08", 2500, "Taco Stand", "out", "cat-dining"),
      entry("e-xfer", "2026-10-10", 20000, "To savings", "out", "cat-groceries", true),
      entry("e-next", "2026-10-11", 999, "Tomorrow", "out", "cat-dining"), // not yet
    ]);
    await db.goals.add({
      id: "jar-trip",
      kind: "save",
      title: "Trip",
      target_cents: 60000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-09-01",
      end_date: "2026-12-31",
      baseline_cents: null,
      group_id: null,
      status: "active",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    });
    await db.goal_events.bulkAdd([
      {
        id: "d-old",
        goal_id: "jar-trip",
        date: "2026-09-30",
        type: "deposit",
        amount_cents: 1000,
        created_at: "2026-09-30T00:00:00Z",
      },
      {
        id: "d-week",
        goal_id: "jar-trip",
        date: "2026-10-07",
        type: "deposit",
        amount_cents: 2500,
        created_at: "2026-10-07T00:00:00Z",
      },
      // Move money to another jar: a withdrawal and a deposit written together, no new money
      {
        id: "m-out",
        goal_id: "jar-trip",
        date: "2026-10-08",
        type: "withdrawal",
        amount_cents: 500,
        created_at: "2026-10-08T00:00:00Z",
      },
      {
        id: "m-in",
        goal_id: "jar-other",
        date: "2026-10-08",
        type: "deposit",
        amount_cents: 500,
        created_at: "2026-10-08T00:00:00Z",
      },
    ]);

    renderApp("/recap");
    expect(await screen.findByRole("heading", { level: 1, name: "Your week" })).toBeInTheDocument();
    expect(await screen.findByText("Oct 4 – Oct 10")).toBeInTheDocument();
    const week = await screen.findByRole("region", { name: "The last 7 days" });
    await waitFor(() => expect(week).toHaveTextContent("Got $1,500.00"));
    expect(week).toHaveTextContent("Spent $67.17"); // 42.17 + 25.00; the transfer is left out
    expect(week).toHaveTextContent("Kept $1,432.83");
    expect(week).toHaveTextContent("$1,432.83 is yours to keep.");
    // the week before kept −$99.99, so this week kept $1,532.82 more
    expect(week).toHaveTextContent("vs the week before: you kept $1,532.82 more.");

    const where = screen.getByRole("region", { name: "Where it went" });
    const rows = within(where).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["Groceries$42.17", "Dining$25.00"]);

    const jars = screen.getByRole("region", { name: "Jars" });
    await waitFor(() => expect(jars).toHaveTextContent("You set aside $25.00 in one deposit."));
    expect(within(jars).getByRole("link", { name: "Trip" })).toHaveAttribute(
      "href",
      "/goals/jar-trip",
    );

    // Stored with the engine's version so the recap can be reproduced; nothing sent anywhere
    await waitFor(async () =>
      expect(await db.computed_results.get("week_totals:2026-10-10")).toMatchObject({
        kind: "week_totals",
        rules_version: RULES_VERSION,
        payload: { in_cents: 150000, out_cents: 6717, net_cents: 143283 },
      }),
    );
  });

  it("asks for an entry when the week is empty, and the push's screen is reachable from settings", async () => {
    const user = userEvent.setup();
    renderApp("/me/notifications");
    const list = await screen.findByRole("list", { name: "Alert types" });
    const row = within(list).getByText("Weekly recap").closest("li") as HTMLElement;
    await user.click(await within(row).findByRole("link", { name: "See this week's recap" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Your week" })).toBeInTheDocument();
    const week = await screen.findByRole("region", { name: "The last 7 days" });
    await waitFor(() => expect(week).toHaveTextContent("Nothing logged these 7 days yet."));
    expect(screen.getByRole("region", { name: "Jars" })).toHaveTextContent("Start a jar");
  });
});
