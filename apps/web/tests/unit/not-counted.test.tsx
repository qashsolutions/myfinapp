import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { duplicateOf } from "../../src/features/entries/entryActions.ts";
import { todayIso } from "../../src/lib/format.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function entry(id: string, merchant: string, cents: number, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    date: todayIso(),
    amount_cents: cents,
    direction: "out",
    merchant,
    clean_description: merchant.toUpperCase(),
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
  await db.balance_anchors.add({
    id: "b1",
    account_id: "acct-cash",
    as_of: "2020-01-01",
    balance_cents: 100000,
    source: "user",
    created_at: "2020-01-01T00:00:00Z",
  });
  await db.entries.bulkAdd([entry("trip", "Work hotel", 50000), entry("cafe", "Corner Cafe", 450)]);
  return db;
}

const outStat = () => screen.getByRole("group", { name: "This month" });

describe("Rename and Don't count (item 7, October 20, 2026)", () => {
  it("Don't count leaves spending totals, stays listed and in the balance, and undoes", async () => {
    const user = userEvent.setup();
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/money");
    await waitFor(() => expect(outStat()).toHaveTextContent("−$504.50"));
    await user.click(screen.getByRole("radio", { name: "Transactions" }));
    const hotel = (await screen.findByText("Work hotel")).closest("li") as HTMLElement;
    // The swipe's actions (also in the editor for keyboards and screen readers).
    fireEvent.click(within(hotel).getByText("Don't count"));
    await waitFor(() => expect(outStat()).toHaveTextContent("−$4.50"));
    expect(within(hotel).getByText(/Not counted/)).toBeInTheDocument();
    expect(await screen.findByText("Not counted in spending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not counted (1)" })).toBeInTheDocument();
    // The money really moved: net worth's cash is still 1,000 − 504.50.
    expect((await db.entries.get("trip"))?.not_counted).toBe(true);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(outStat()).toHaveTextContent("−$504.50"));
  });

  it("the editor's switch does the same, and net worth keeps the money", async () => {
    const user = userEvent.setup();
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/entries/trip");
    await waitFor(() => expect(screen.getByLabelText("Merchant")).toHaveValue("Work hotel"));
    await user.click(screen.getByRole("switch", { name: "Count in my spending" }));
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(async () => expect((await db.entries.get("trip"))?.not_counted).toBe(true));
  });

  it("net worth still counts a not-counted entry", async () => {
    const db = await seed();
    await db.entries.update("trip", { not_counted: true });
    installFakeApi({ session: readySession() });
    renderApp("/net-worth");
    // 1,000 − 500 − 4.50
    expect(await screen.findByRole("region", { name: "$495.50" })).toBeInTheDocument();
  });

  it("renames every entry like it from the editor and keeps the name for later", async () => {
    const user = userEvent.setup();
    const db = await seed();
    await db.entries.bulkAdd([
      entry("a1", "AMZN MKTP US*2K4", 1999, {
        source: "import",
        clean_description: "AMZN MKTP US",
      }),
      entry("a2", "AMZN MKTP US*9Q1", 2599, {
        source: "import",
        clean_description: "AMZN MKTP US",
      }),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/entries/a1");
    const name = await screen.findByLabelText("Merchant");
    await waitFor(() => expect(name).toHaveValue("AMZN MKTP US*2K4"));
    await user.clear(name);
    await user.type(name, "Amazon");
    expect(await screen.findByRole("switch", { name: "Rename all 2 like this" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(async () => expect((await db.entries.get("a2"))?.merchant).toBe("Amazon"));
    expect((await db.merchant_names.toArray()).map((n) => [n.match, n.name])).toEqual([
      ["AMZN MKTP US", "Amazon"],
    ]);
  });

  it("points out a likely duplicate rather than hiding it", async () => {
    const db = await seed();
    await db.entries.add(entry("cafe2", "Corner Cafe", 450, { account_id: "acct-other" }));
    const twin = await duplicateOf(db, (await db.entries.get("cafe")) as Entry);
    expect(twin?.id).toBe("cafe2");
    installFakeApi({ session: readySession() });
    renderApp("/entries/cafe?duplicate=cafe2");
    expect(await screen.findByText(/Looks like a duplicate of Corner Cafe/)).toBeInTheDocument();
  });
});
