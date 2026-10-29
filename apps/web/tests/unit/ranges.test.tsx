import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { formatMonth, todayIso } from "../../src/lib/format.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

/** The `day` of the month `back` months before this one, as ISO. */
function monthsAgo(back: number, day: number): string {
  const [y, m] = todayIso().split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - back, day));
  return d.toISOString().slice(0, 10);
}

function entry(id: string, date: string, cents: number, extra: Partial<Entry>): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction: "out",
    merchant: id,
    clean_description: id.toUpperCase(),
    raw_description: null,
    category_id: "cat-dining",
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    entry("now", monthsAgo(0, 1), 1000, {}),
    entry("pay", monthsAgo(1, 5), 300000, { direction: "in", category_id: "cat-paycheck" }),
    entry("rent", monthsAgo(1, 6), 50000, { category_id: "cat-rent" }),
    entry("first", monthsAgo(2, 10), 2000, {}),
  ]);
  return db;
}

describe("time ranges on Money in & out (October 20, 2026)", () => {
  it("adds up 3 months, says the history is short, and remembers the range", async () => {
    const user = userEvent.setup();
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/money");
    await user.click(await screen.findByRole("radio", { name: "the last 3 months" }));
    const stats = await screen.findByRole("group", { name: "the last 3 months" });
    await waitFor(() => expect(stats).toHaveTextContent("+$3,000.00"));
    expect(stats).toHaveTextContent("−$530.00");
    expect(stats).toHaveTextContent("$2,470.00");
    // The first month starts on the 10th: shown, never averaged (invariant 51), so
    // (3,000 − 500 − 10) ÷ the 2 whole months = $1,245.00 a month
    expect(screen.getByText(/About \$1,245\.00 a month kept/)).toBeInTheDocument();
    expect(
      screen.getByText(/not enough history yet to compare with the 3 months before/),
    ).toBeInTheDocument();
    expect(screen.getByText(/You have 3 months so far/)).toBeInTheDocument();
    const where = screen.getByRole("region", { name: "By category" });
    expect(within(where).getByText("Rent")).toBeInTheDocument();
    expect(localStorage.getItem("stackd.range.money")).toBe("Quarter");
  });

  it("opens a month from its bars", async () => {
    const user = userEvent.setup();
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/money");
    await user.click(await screen.findByRole("radio", { name: "the last 12 months" }));
    const month = formatMonth(monthsAgo(1, 1));
    const short = month.slice(0, 3);
    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(`^${short}: in \\$3,000\\.00, out \\$500\\.00`),
      }),
    );
    expect(await screen.findByText(month)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "this month" })).toBeChecked();
  });

  it("steps a whole year back with Earlier, and Next looks 30 days ahead", async () => {
    const user = userEvent.setup();
    const db = await seed();
    await db.entries.add(entry("old", monthsAgo(14, 3), 7000, {}));
    installFakeApi({ session: readySession() });
    renderApp("/money");
    await user.click(await screen.findByRole("radio", { name: "the last 12 months" }));
    const earlier = await screen.findByRole("button", { name: "‹ Earlier" });
    expect(screen.getByRole("button", { name: "Later ›" })).toBeDisabled();
    await waitFor(() => expect(earlier).toBeEnabled());
    await user.click(earlier);
    // The 12 months before: only the old $70.00
    const stats = await screen.findByRole("group", { name: "the last 12 months" });
    await waitFor(() => expect(stats).toHaveTextContent("−$70.00"));
    expect(screen.getByRole("button", { name: "‹ Earlier" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Later ›" }));
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "the last 12 months" })).toHaveTextContent(
        "−$530.00",
      ),
    );

    // An old saved "1Y" is read as Year
    localStorage.setItem("stackd.range.money", "1Y");
    await user.click(screen.getByRole("radio", { name: "the next 30 days" }));
    const verdict = await screen.findByRole("region", { name: /^(Saving|Over)$/ });
    expect(verdict).toHaveTextContent(/over the next 30 days/);
    expect(screen.getByRole("link", { name: "See it day by day" })).toBeInTheDocument();
  });

  it("reads a range saved before October 25, 2026", async () => {
    await seed();
    localStorage.setItem("stackd.range.money", "1Y");
    installFakeApi({ session: readySession() });
    renderApp("/money");
    expect(await screen.findByRole("radio", { name: "the last 12 months" })).toBeChecked();
  });
});
