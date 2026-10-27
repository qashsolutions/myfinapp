import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
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
