import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import {
  isRegularSpending,
  REGULAR_CALLS_KEY,
  REGULAR_CATEGORIES_KEY,
} from "../../src/features/forecast/useRecurring.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-19T12:00:00");

function entry(
  id: string,
  date: string,
  cents: number,
  merchant: string,
  direction: "in" | "out",
  category: string | null,
  transfer = false,
): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "import",
    receipt_id: null,
    import_id: null,
    is_transfer: transfer,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
  };
}

/** Three months of a statement: biweekly pay, rent, internet and a streaming subscription. */
function statement(): Entry[] {
  const rows: Entry[] = [];
  for (const [i, d] of [
    "2026-08-07",
    "2026-08-21",
    "2026-09-04",
    "2026-09-18",
    "2026-10-02",
    "2026-10-16",
  ].entries())
    rows.push(entry(`pay${i}`, d, 245000, "ACME CORP PAYROLL", "in", "cat-paycheck"));
  for (const m of ["08", "09", "10"]) {
    rows.push(
      entry(`rent${m}`, `2026-${m}-01`, 165000, "MAPLE GROVE APTS RENT", "out", "cat-rent"),
    );
    rows.push(entry(`net${m}`, `2026-${m}-14`, 7999, "XFINITY INTERNET", "out", "cat-utilities"));
    rows.push(entry(`flix${m}`, `2026-${m}-07`, 1549, "NETFLIX.COM", "out", "cat-subscriptions"));
  }
  rows.push(entry("tj", "2026-10-10", 8437, "TRADER JOE'S", "out", "cat-groceries"));
  return rows;
}

describe("Home, visual (October 19, 2026)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leads with what was kept, draws in vs out and where it went, and offers what it found", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd(statement());
    installFakeApi({ session: readySession() });
    renderApp("/");

    // Oct: in $4,900; out $1,650 + $79.99 + $15.49 + $84.37 = $1,829.85; kept $3,070.15
    const hero = await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() => expect(hero).toHaveTextContent("$3,070.15 kept"));
    await waitFor(() => expect(hero).toHaveTextContent("You spent less than you earned"));
    expect(hero.querySelectorAll(".hero-bars__row")).toHaveLength(2);

    const where = screen.getByRole("list", { name: "Top spending categories" });
    const names = within(where)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".cat-bars__name")?.textContent);
    expect(names[0]).toBe("Rent");
    expect(where.querySelector(".cat-bars__fill--need")).not.toBeNull();

    const found = await screen.findByRole("region", { name: "Confirm to see what's coming" });
    await waitFor(() => expect(found).toHaveTextContent("1subscription"));
    expect(found).toHaveTextContent("2bills");
    expect(found).toHaveTextContent("1paycheck");

    // The paycheck becomes Budget's pay in one tap, and isn't also kept as a second income series
    await user.click(
      within(found).getByRole("button", { name: "Use $2,450.00 every 2 weeks as my pay" }),
    );
    await waitFor(async () =>
      expect((await db.settings.get("pay"))?.value).toMatchObject({
        amount_cents: 245000,
        frequency: "biweekly",
        next_payday: "2026-10-30",
      }),
    );
    expect(await db.recurring_series.where("status").equals("dismissed").count()).toBe(1);

    await user.click(within(found).getByRole("button", { name: "Confirm all 3" }));
    await waitFor(async () =>
      expect(await db.recurring_series.where("status").equals("confirmed").count()).toBe(3),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Confirm to see what's coming" })).toBeNull(),
    );
  });

  it("weekly groceries, takeout and gas are regular spending, never offered as bills (invariant 52)", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const rows: Entry[] = [];
    const weeks = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];
    for (const [i, d] of weeks.entries()) {
      rows.push(entry(`tj${i}`, d, 8400 + i * 10, "TRADER JOE'S", "out", "cat-groceries"));
      rows.push(entry(`ch${i}`, d, 1450, "CHIPOTLE 1234", "out", "cat-dining"));
      rows.push(entry(`sh${i}`, d, 4500, "SHELL OIL 57444", "out", "cat-transport"));
      rows.push(entry(`ue${i}`, d, 3200, "UBER EATS", "out", "cat-dining"));
      // A weekly charge outside the everyday categories is still a bill to look at
      rows.push(entry(`sit${i}`, d, 30000, "SITTER CO", "out", null));
    }
    for (const m of ["08", "09", "10"])
      rows.push(
        entry(`rent${m}`, `2026-${m}-01`, 165000, "MAPLE GROVE APTS RENT", "out", "cat-rent"),
      );
    await db.entries.bulkAdd(rows);
    installFakeApi({ session: readySession() });
    renderApp("/");

    const found = await screen.findByRole("region", { name: "Confirm to see what's coming" });
    await waitFor(() => expect(found).toHaveTextContent("2bills"));
    expect(found).not.toHaveTextContent(/TRADER JOE|CHIPOTLE|SHELL|UBER EATS/);
    // Confirm all takes the monthly rent only; the weekly sitter is reviewed on Bills
    await user.click(within(found).getByRole("button", { name: "Confirm 1 monthly" }));
    await waitFor(async () =>
      expect(await db.recurring_series.where("status").equals("confirmed").count()).toBe(1),
    );
    const [rent] = await db.recurring_series.toArray();
    expect(rent).toMatchObject({ payee: "MAPLE GROVE APTS RENT", interval: "monthly" });
    // No grocery, takeout or gas charge became a bill's charge
    const marked = (await db.entries.toArray()).filter((e) => e.is_recurring).map((e) => e.id);
    expect(marked.sort()).toEqual(["rent08", "rent09", "rent10"]);

    renderApp("/bills");
    const regular = await screen.findByRole("region", { name: "Regular spending, not bills" });
    for (const name of ["TRADER JOE'S", "CHIPOTLE 1234", "SHELL OIL 57444", "UBER EATS"])
      expect(regular).toHaveTextContent(name);
    // Shown, never confirmable as it is: only the person's own "This is a bill"
    expect(within(regular).queryByRole("button", { name: /Yes, it's a bill/ })).toBeNull();
    expect(screen.getByRole("region", { name: "Suggestion: SITTER CO" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Suggestion: TRADER JOE/ })).toBeNull();
  });

  it("the person's everyday categories and their own call decide; the call always wins (invariant 52)", () => {
    const byId = new Map([
      ["c1", { category_id: "cat-dining" }],
      ["c2", { category_id: "cat-dining" }],
      ["s1", { category_id: null }],
      ["s2", { category_id: null }],
    ]);
    const chipotle = {
      kind: "bill" as const,
      interval: "weekly" as const,
      payee: "CHIPOTLE",
      entry_ids: ["c1", "c2"],
    };
    const sitter = {
      kind: "bill" as const,
      interval: "weekly" as const,
      payee: "SITTER CO",
      entry_ids: ["s1", "s2"],
    };
    const dining = new Set(["cat-dining"]);
    const noDining = new Set(["cat-groceries"]);
    expect(isRegularSpending(chipotle, byId)).toBe(true);
    expect(isRegularSpending(chipotle, byId, { categories: noDining, calls: {} })).toBe(false);
    expect(
      isRegularSpending(chipotle, byId, { categories: dining, calls: { CHIPOTLE: "bill" } }),
    ).toBe(false);
    expect(
      isRegularSpending(sitter, byId, { categories: dining, calls: { "SITTER CO": "regular" } }),
    ).toBe(true);
    // Monthly-or-longer and money in stay bills whatever the call
    expect(
      isRegularSpending({ ...chipotle, interval: "monthly" }, byId, {
        categories: dining,
        calls: { CHIPOTLE: "regular" },
      }),
    ).toBe(false);
    expect(isRegularSpending({ ...chipotle, kind: "income" }, byId)).toBe(false);
  });

  it("This is a bill confirms Trader Joe's into the 30-day list; This is regular spending takes it back; Adjust and calls reach Confirm all", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const rows: Entry[] = [];
    for (const [i, d] of ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"].entries()) {
      rows.push(entry(`tj${i}`, d, 8400, "TRADER JOE'S", "out", "cat-groceries"));
      rows.push(entry(`ch${i}`, d, 1450, "CHIPOTLE 1234", "out", "cat-dining"));
      rows.push(entry(`sit${i}`, d, 30000, "SITTER CO", "out", null));
    }
    for (const m of ["08", "09", "10"])
      rows.push(
        entry(`rent${m}`, `2026-${m}-01`, 165000, "MAPLE GROVE APTS RENT", "out", "cat-rent"),
      );
    await db.entries.bulkAdd(rows);
    installFakeApi({ session: readySession() });

    // The person's call on the sitter and Dining no longer everyday, both saved as settings
    await db.settings.put({
      key: REGULAR_CALLS_KEY,
      value: { "SITTER CO": "regular" },
      updated_at: "x",
    });
    await db.settings.put({
      key: REGULAR_CATEGORIES_KEY,
      value: ["cat-groceries"],
      updated_at: "x",
    });
    renderApp("/");
    const found = await screen.findByRole("region", { name: "Confirm to see what's coming" });
    // Rent and Chipotle (Dining is not everyday now); the sitter is regular by their call
    await waitFor(() => expect(found).toHaveTextContent("2bills"));
    expect(found).not.toHaveTextContent("SITTER CO");
    await user.click(within(found).getByRole("button", { name: "Confirm 1 monthly" }));
    await waitFor(async () =>
      expect(await db.recurring_series.where("status").equals("confirmed").count()).toBe(1),
    );

    renderApp("/bills");
    const regular = await screen.findByRole("region", { name: "Regular spending, not bills" });
    expect(regular).toHaveTextContent("SITTER CO");
    expect(regular).not.toHaveTextContent("CHIPOTLE");
    await user.click(within(regular).getByRole("button", { name: "TRADER JOE'S: this is a bill" }));
    await waitFor(async () =>
      expect(await db.recurring_series.where("payee").equals("TRADER JOE'S").count()).toBe(1),
    );
    await waitFor(async () => expect((await db.entries.get("tj0"))?.is_recurring).toBe(true));
    expect((await db.settings.get(REGULAR_CALLS_KEY))?.value).toMatchObject({
      "TRADER JOE'S": "bill",
    });

    // Back again from the bill's own sheet
    const list = await screen.findByRole("list", { name: "Bills and income" });
    await user.click(within(list).getByRole("button", { name: /TRADER JOE'S/ }));
    const sheet = await screen.findByRole("dialog", { name: "Edit" });
    await user.click(within(sheet).getByRole("button", { name: "This is regular spending" }));
    await waitFor(async () =>
      expect(await db.recurring_series.where("payee").equals("TRADER JOE'S").count()).toBe(0),
    );
    await waitFor(async () => expect((await db.entries.get("tj0"))?.is_recurring).toBe(false));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Regular spending, not bills" })).toHaveTextContent(
        "TRADER JOE'S",
      ),
    );
  });

  it("says only transfers so far when that's all the month has", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("t1", "2026-10-02", 20000, "TRANSFER FROM CHECKING", "in", null, true),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/");
    const hero = await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() => expect(hero).toHaveTextContent("Only transfers so far"));
    expect(hero).not.toHaveTextContent("Nothing yet");
  });
});
