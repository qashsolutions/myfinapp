/**
 * Searching the person's own data (owner decision, November 16, 2026; invariant 91): merchants,
 * entries, amounts, jars, bills, tags and accounts, read on this device only. Nothing typed or
 * found is sent or kept, a result never leads where the person can't go, and See all carries what
 * was searched in navigation state, never the address.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { createGoal } from "../../src/features/goals/useGoals.ts";
import { searchData } from "../../src/features/search/dataSearch.ts";
import { formatCents, formatDay } from "../../src/lib/format.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const fmt = { money: formatCents, day: (d: string) => formatDay(d) };

function entry(
  id: string,
  date: string,
  cents: number,
  merchant: string,
  extra: Partial<Entry> = {},
): Entry {
  return {
    id,
    date,
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
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
    ...extra,
  };
}

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    entry("s1", "2026-10-01", 545, "Starbucks"),
    entry("s2", "2026-10-08", 610, "Starbucks"),
    entry("s3", "2026-10-15", 575, "STARBUCKS"),
    entry("s4", "2026-10-20", 495, "Starbucks"),
    entry("s5", "2026-10-25", 520, "Starbucks"),
    entry("n1", "2026-10-03", 1549, "Netflix", { category_id: "cat-subscriptions" }),
    entry("d1", "2026-10-12", 8420, "Bistro Nove", { note: "Birthday dinner", tags: ["hawaii"] }),
    entry("h1", "2026-10-14", 32000, "Island Air", { tags: ["hawaii"] }),
  ]);
  await createGoal(db, {
    kind: "save",
    title: "Hawaii",
    target_cents: 300000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-10-01",
    end_date: "2027-06-01",
    baseline_cents: null,
    group_id: null,
  });
  const old = await createGoal(db, {
    kind: "save",
    title: "Old car",
    target_cents: 100000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-01-01",
    end_date: null,
    baseline_cents: null,
    group_id: null,
  });
  await db.goals.update(old, { status: "archived" });
  await db.recurring_series.add({
    id: "r1",
    payee: "CITY UTILITIES",
    label: "City Utilities",
    kind: "bill",
    expected_cents: 9000,
    interval: "monthly",
    next_date: "2026-11-20",
    status: "confirmed",
    source: "manual",
    account_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });
  return db;
}

const titles = (r: Awaited<ReturnType<typeof searchData>>) => r.sections.map((s) => s.title);
const labelsIn = (r: Awaited<ReturnType<typeof searchData>>, title: string) =>
  r.sections.find((s) => s.title === title)?.hits.map((h) => h.label) ?? [];

beforeEach(() => {
  resetEntitlements();
  localStorage.clear();
});

describe("what your own data search finds", () => {
  it("a merchant by part of its name, once, however the bank wrote it", async () => {
    const db = await seed();
    const r = await searchData(db, "bucks", fmt);
    expect(labelsIn(r, "Merchants")).toEqual(["Starbucks"]);
    const m = r.sections.find((s) => s.title === "Merchants")?.hits[0];
    expect(m?.detail).toMatch(/5 entries · last/);
    expect(m?.path).toBe("/search/entries");
    expect(m?.state?.match.merchant).toBe("starbucks");
  });

  it("entries newest first, a few at a time, with See all", async () => {
    const db = await seed();
    const r = await searchData(db, "starbucks", fmt);
    const entries = r.sections.find((s) => s.title === "Entries");
    expect(entries?.hits.map((h) => h.key)).toEqual([
      "entry:s5",
      "entry:s4",
      "entry:s3",
      "entry:s2",
    ]);
    expect(entries?.all?.label).toBe("See all 5 entries");
  });

  it("an amount typed on its own finds that exact amount", async () => {
    const db = await seed();
    for (const q of ["84.20", "$84.20"]) {
      const r = await searchData(db, q, fmt);
      expect(labelsIn(r, "Entries")).toEqual(["Bistro Nove"]);
    }
    expect(labelsIn(await searchData(db, "84", fmt), "Entries")).toEqual([]);
  });

  it("notes, tags, jars, bills and accounts", async () => {
    const db = await seed();
    expect(labelsIn(await searchData(db, "birthday", fmt), "Entries")).toEqual(["Bistro Nove"]);
    const hawaii = await searchData(db, "hawaii", fmt);
    expect(titles(hawaii)).toEqual(["Entries", "Jars & goals", "Tags"]);
    expect(labelsIn(hawaii, "Tags")).toEqual(["#hawaii"]);
    expect(labelsIn(hawaii, "Jars & goals")).toEqual(["Hawaii"]);
    expect(labelsIn(await searchData(db, "utilities", fmt), "Bills")).toEqual(["City Utilities"]);
    expect(labelsIn(await searchData(db, "cash", fmt), "Accounts")).toEqual(["Cash"]);
  });

  it("a removed jar stays out, one letter finds nothing, and it's the same every time", async () => {
    const db = await seed();
    expect(labelsIn(await searchData(db, "old car", fmt), "Jars & goals")).toEqual([]);
    expect((await searchData(db, "s", fmt)).sections).toEqual([]);
    const a = await searchData(db, "a", fmt);
    expect(a.sections).toEqual([]);
    expect(await searchData(db, "starbucks", fmt)).toEqual(await searchData(db, "starbucks", fmt));
  });
});

describe("in the search sheet", () => {
  it("a merchant opens all its entries and what they add up to; nothing is sent or kept", async () => {
    await seed();
    const api = installFakeApi({ session: readySession() });
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const before = api.calls.length;
    await user.type(within(dialog).getByRole("combobox"), "starbucks");
    const merchants = await within(dialog).findByRole("group", { name: "Merchants" });
    expect(within(dialog).getByRole("group", { name: "Entries" })).toHaveTextContent(
      "See all 5 entries",
    );
    await user.click(within(merchants).getByRole("option", { name: /Starbucks/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Starbucks" })).toBeInTheDocument();
    const total = await screen.findByRole("region", { name: "What they add up to" });
    expect(total).toHaveTextContent("$27.45");
    expect(
      within(screen.getByRole("list", { name: "Entries for Starbucks" })).getAllByRole("button"),
    ).toHaveLength(5);

    const sent = api.calls
      .slice(before)
      .map((c) => `${c.url} ${c.raw}`)
      .join("\n");
    expect(sent).not.toMatch(/starbucks/i);
    // Picking your own data is never remembered
    expect(localStorage.getItem("stackd.search.recent.u1")).toBeNull();
    expect(JSON.stringify(localStorage)).not.toMatch(/starbucks/i);
  });

  it("with your own matches too, the app's best three places come first, then yours", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await user.type(within(dialog).getByRole("combobox"), "pay");
    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "netflix");
    await within(dialog).findByRole("group", { name: "Merchants" });
    const places = within(dialog).getByRole("group", { name: "In Qash" });
    expect(within(places).getAllByRole("option").length).toBeLessThanOrEqual(3);
    expect(places).toHaveTextContent("Subscriptions");
    const groups = within(dialog)
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"));
    expect(groups.indexOf("In Qash")).toBeLessThan(groups.indexOf("Merchants"));
  });

  it("an amount opens its entry", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await user.type(within(dialog).getByRole("combobox"), "84.20");
    const entries = await within(dialog).findByRole("group", { name: "Entries" });
    expect(entries).toHaveTextContent("Bistro Nove");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    expect(await screen.findByDisplayValue("Bistro Nove")).toBeInTheDocument();
  });

  it("See all opened without its search (a pasted link) shows nothing and offers to search again", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/search/entries");
    expect(
      await screen.findByText("Nothing to show. Searches aren't kept, so search again."),
    ).toBeInTheDocument();
  });

  it("a split-bill guest gets no results from data they can't open", async () => {
    await seed();
    const api = installFakeApi({ session: readySession() });
    api.access = { state: "lapsed", plan: "free", trial_used: true, split_guest: true };
    const user = userEvent.setup();
    renderApp("/splits");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    await user.type(within(dialog).getByRole("combobox"), "starbucks");
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent("Nothing matches"),
    );
    expect(within(dialog).queryByRole("group", { name: "Merchants" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Entries" })).toBeNull();
  });
});
