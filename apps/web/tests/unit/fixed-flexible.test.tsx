/**
 * Fixed vs flexible (October 28, 2026, docs/spec.md): money out on confirmed bills and
 * subscriptions against the rest, split by bucket, and the kept rate against the same days of
 * last month. Every number comes from `cashflow.fixed_flexible` through the engine.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import type { FixedFlexible } from "../../src/engine/bridge.ts";
import { fixedWord } from "../../src/features/fixed/useFixedFlexible.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-28T12:00:00");

function entry(
  id: string,
  date: string,
  cents: number,
  direction: "in" | "out",
  category: string,
  recurring = false,
): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant: id,
    clean_description: id.toUpperCase(),
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: recurring,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
  } as Entry;
}

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    // October so far: in 3,000.00; fixed rent 1,500 + Netflix 15.99; flexible dining 310 +
    // shopping 190. Kept 984.01 of 3,000 = 3280.03 bps → 3280 (33%).
    entry("pay-oct", "2026-10-01", 300000, "in", "cat-paycheck"),
    entry("rent-oct", "2026-10-01", 150000, "out", "cat-rent", true),
    entry("netflix-oct", "2026-10-05", 1599, "out", "cat-subscriptions", true),
    entry("dining-oct", "2026-10-10", 31000, "out", "cat-dining"),
    entry("shop-oct", "2026-10-12", 19000, "out", "cat-shopping"),
    // A "Don't count" entry is left out like every spending total
    { ...entry("odd-oct", "2026-10-13", 99900, "out", "cat-shopping"), not_counted: true },
    // September 1–28: kept 500 of 3,000 = 1667 bps; the 29th is after the same days
    entry("pay-sep", "2026-09-01", 300000, "in", "cat-paycheck"),
    entry("rent-sep", "2026-09-01", 150000, "out", "cat-rent", true),
    entry("dining-sep", "2026-09-10", 100000, "out", "cat-dining"),
    entry("late-sep", "2026-09-29", 40000, "out", "cat-dining"),
  ]);
  return db;
}

describe("Fixed vs flexible", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows fixed and flexible, the kept rate and the most room on Insights", async () => {
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    const card = await screen.findByRole("link", { name: "Fixed vs flexible" });
    await waitFor(() =>
      expect(card).toHaveTextContent("33% kept · fixed $1,515.99 · flexible $500.00"),
    );
    // 33% this month against 17% on the same days of September
    expect(card).toHaveTextContent("Up");
    expect(card).toHaveTextContent("Most room: Dining $310.00, Shopping $190.00");
    const stored = await db.computed_results.get("fixed_flexible:2026-10-28");
    expect(stored?.rules_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists each category and the kept rate by month on the detail screen", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/insights/fixed-flexible");
    const categories = await screen.findByRole("region", { name: "Each category" });
    await waitFor(() => expect(within(categories).getAllByRole("row")).toHaveLength(5));
    const rent = within(categories).getByRole("row", { name: /Rent/ });
    expect(rent).toHaveTextContent("Rent$1,500.00$0.00");
    expect(within(categories).getByRole("row", { name: /Dining/ })).toHaveTextContent(
      "Dining$0.00$310.00",
    );
    const months = screen.getByRole("region", { name: "Kept rate by month" });
    // July and August have nothing and are left off; September whole:
    // (3,000 − 1,500 − 1,000 − 400) ÷ 3,000 = 3.33%
    const bars = within(months).getByRole("img", { name: /^Kept rate by month/ });
    expect(bars).toHaveAccessibleName("Kept rate by month: September 2026 3%, October 2026 33%");
    // The month as a ring with the kept rate in the middle and each part's amount beside it
    expect(
      screen.getByRole("img", {
        name: "October 2026: 33% kept. Fixed $1,515.99, Flexible $0.00, Wants (room) $500.00.",
      }),
    ).toBeVisible();
  });

  it("opens What if on a room category, prefilled with an amount that fits", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/insights/fixed-flexible");
    const room = await screen.findByRole("region", { name: "Most room" });
    // Dining $310: the largest of What if's suggestions inside it is $100
    const dining = await within(room).findByRole("link", { name: /^Dining \$310\.00/ });
    expect(dining).toHaveAttribute("href", "/what-if?lever=spend&category=cat-dining&amount=10000");
    // Two at most (signed off October 29, 2026)
    expect(within(room).getAllByRole("link")).toHaveLength(2);
  });

  it("takes the person's own call: Adjust treats Dining as fixed and Rent as flexible", async () => {
    const db = await seed();
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/insights/fixed-flexible");
    await screen.findByRole("region", { name: "Each category" });
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust fixed vs flexible" });
    const pick = (where: HTMLElement, group: string, name: string) =>
      user.click(
        within(within(where).getByRole("group", { name: group })).getByRole("radio", { name }),
      );
    await pick(sheet, "Dining", "Fixed");
    await pick(sheet, "Rent", "Flexible");
    await waitFor(async () =>
      expect((await db.settings.get("fixed.override"))?.value).toEqual({
        "cat-dining": "fixed",
        "cat-rent": "flexible",
      }),
    );
    await user.click(within(sheet).getByRole("button", { name: "Done" }));
    const categories = screen.getByRole("region", { name: "Each category" });
    await waitFor(() =>
      expect(within(categories).getByRole("row", { name: /Dining/ })).toHaveTextContent(
        "Dining$310.00$0.00",
      ),
    );
    expect(within(categories).getByRole("row", { name: /Rent/ })).toHaveTextContent(
      "Rent$0.00$1,500.00",
    );
    // Back to what the bills say
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const again = await screen.findByRole("dialog", { name: "Adjust fixed vs flexible" });
    await pick(again, "Rent", "From bills");
    await waitFor(async () =>
      expect((await db.settings.get("fixed.override"))?.value).toEqual({ "cat-dining": "fixed" }),
    );
  });

  it("joins Money in & out's month view", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/money");
    const card = await screen.findByRole("region", { name: "Fixed vs flexible" });
    await waitFor(() => expect(card).toHaveTextContent("fixed $1,515.99"));
    expect(within(card).getByRole("link", { name: /Each category/ })).toHaveAttribute(
      "href",
      "/insights/fixed-flexible?month=2026-10-28",
    );
    // Each room category opens What if
    expect(within(card).getByRole("link", { name: "Shopping $190.00" })).toHaveAttribute(
      "href",
      "/what-if?lever=spend&category=cat-shopping&amount=10000",
    );
  });

  it("picks its one word from the kept rate against last month", () => {
    const r = (in_cents: number, out_cents: number, kept_rate_bps: number | null) =>
      ({ in_cents, out_cents, kept_cents: in_cents - out_cents, kept_rate_bps }) as FixedFlexible;
    expect(fixedWord(r(0, 0, null), r(100, 50, 5000))).toBe("Start");
    expect(fixedWord(r(100, 80, 2000), r(100, 50, 5000))).toBe("Down");
    expect(fixedWord(r(100, 50, 5000), r(100, 50, 5000))).toBe("Steady");
    expect(fixedWord(r(0, 50, null), r(100, 50, 5000))).toBe("Over");
    expect(fixedWord(r(100, 50, 5000), r(0, 0, null))).toBe("Kept");
  });
});
