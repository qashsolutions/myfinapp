import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, type StackdDb, seedDefaults } from "../../src/data/db.ts";
import { momentsLog } from "../../src/moments/bus.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

// Thursday. Its week starts Monday, November 16; the weeks before start Nov 9, Nov 2, Oct 26…
const TODAY = new Date("2026-11-19T12:00:00");

async function seedJar(
  db: StackdDb,
  start: string,
  deposits: string[],
  title = "Trip",
  cents = 2000,
) {
  const id = `jar-${title}`;
  await db.goals.add({
    id,
    kind: "save",
    title,
    target_cents: 500000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: start,
    end_date: null,
    baseline_cents: null,
    group_id: null,
    status: "active",
    created_at: `${start}T00:00:00Z`,
    updated_at: `${start}T00:00:00Z`,
  });
  await db.goal_events.bulkAdd(
    deposits.map((date, i) => ({
      id: `${id}-d${i}`,
      goal_id: id,
      date,
      type: "deposit" as const,
      amount_cents: cents,
      created_at: `${date}T10:00:00Z`,
    })),
  );
  return id;
}

async function setting(db: StackdDb, key: string): Promise<unknown> {
  return (await db.settings.get(key))?.value;
}

function setAsideCard() {
  return screen.findByRole("region", { name: "Set aside" });
}

describe("Streaks, Your path and milestones (invariant 94)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    momentsLog.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("Home's card is hidden until there is a jar", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("button", { name: "Customize Home" });
    expect(screen.queryByRole("link", { name: "Streaks, open Streaks" })).toBeNull();
  });

  it("Home's card counts weeks in a row with this week's deposit day, and celebrates once", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    // Weeks of Nov 2, Nov 9 and this one each have a deposit: three in a row.
    await seedJar(db, "2026-11-02", ["2026-11-03", "2026-11-10", "2026-11-18"]);
    installFakeApi({ session: readySession() });
    renderApp("/");
    const card = await screen.findByRole("link", { name: "Streaks, open Streaks" });
    await waitFor(() => expect(card).toHaveTextContent("3 weeks"));
    // The only streak with data leads; nothing else to tile.
    expect(card).toHaveTextContent("Set aside · keep it going");
    expect(within(card).queryByRole("list", { name: "Your other streaks" })).toBeNull();
    // Wednesday the 18th carries the deposit.
    const days = within(card).getByRole("list", { name: "This week" });
    expect(within(days).getAllByRole("listitem")[2]).toHaveTextContent("Set aside on W");
    await waitFor(() =>
      expect(momentsLog.filter((m) => m.type === "streak_kept")).toEqual([
        { type: "streak_kept", vars: { weeks: "3" }, seed: "streak:2026-11-16" },
      ]),
    );
    expect(await setting(db, "streaks.celebrated")).toBe("2026-11-16");
    await user.click(card);
    expect(await setAsideCard()).toHaveTextContent("3 weeks");
    // Opening the tab reads it again but never celebrates the same week twice.
    expect(momentsLog.filter((m) => m.type === "streak_kept")).toHaveLength(1);
  });

  it("Home leads with the longest streak going and tiles the others (H1 + H4)", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    // Sorted: entries with a category in the weeks of Oct 26, Nov 2 and Nov 9: three whole weeks.
    await db.entries.bulkAdd(
      ["2026-10-27", "2026-11-03", "2026-11-10"].map((date, i) => ({
        id: `e${i}`,
        date,
        amount_cents: 1500,
        direction: "out" as const,
        merchant: "Grocer",
        clean_description: "GROCER",
        raw_description: "GROCER",
        category_id: "cat-groceries",
        account_id: "acct-chk",
        source: "manual" as const,
        receipt_id: null,
        import_id: null,
        is_transfer: false,
        transfer_pair_id: null,
        split_parent_id: null,
        is_recurring: false,
        created_at: `${date}T10:00:00Z`,
        updated_at: `${date}T10:00:00Z`,
      })),
    );
    // Set aside: Nov 9 and this week: two.
    await seedJar(db, "2026-11-09", ["2026-11-10", "2026-11-18"]);
    installFakeApi({ session: readySession() });
    renderApp("/");
    const card = await screen.findByRole("link", { name: "Streaks, open Streaks" });
    await waitFor(() => expect(card).toHaveTextContent("Sorted · your longest going"));
    expect(within(card).getByText("3 weeks")).toHaveClass("word");
    // Sorted leads, so its weeks show instead of this week's days.
    expect(within(card).queryByRole("list", { name: "This week" })).toBeNull();
    const tiles = within(card).getByRole("list", { name: "Your other streaks" });
    expect(within(tiles).getAllByRole("listitem")).toHaveLength(1);
    expect(tiles).toHaveTextContent("Set aside2 weeks");
  });

  it("a missed week is a Fresh start, and a rest week keeps the run", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    // Oct 19, Oct 26 and Nov 2 kept; Nov 9 missed; this week not yet.
    await seedJar(db, "2026-10-19", ["2026-10-20", "2026-10-27", "2026-11-03"]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const card = await setAsideCard();
    await waitFor(() => expect(card).toHaveTextContent("Fresh start"));
    expect(within(card).getByText("Fresh start")).toHaveClass("word--plain");
    expect(card).toHaveTextContent("Your best stays 3 weeks.");
    await user.click(within(card).getByRole("button", { name: "Use a rest week · keep your 3" }));
    await waitFor(() => expect(card).not.toHaveTextContent("Fresh start"));
    expect(within(card).getByText("3 weeks")).toHaveClass("word");
    expect(await setting(db, "streaks.rests")).toEqual({
      set_aside: ["2026-11-09"],
      under_plan: [],
      sorted: [],
    });
  });

  it("Start again answers the missed week without a rest", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-10-19", ["2026-10-20", "2026-10-27", "2026-11-03"]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const card = await setAsideCard();
    await waitFor(() => expect(card).toHaveTextContent("Fresh start"));
    await user.click(within(card).getByRole("button", { name: "Start again this week" }));
    await waitFor(() => expect(card).not.toHaveTextContent("Fresh start"));
    expect(within(card).getByText("Start")).toBeInTheDocument();
    expect(card).toHaveTextContent("Best 3 weeks");
    expect(await setting(db, "streaks.fresh_seen")).toEqual({ set_aside: "2026-11-09" });
  });

  it("no rest weeks left says when they come back, and still offers Start again", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    // Oct 5 kept, Oct 12 rest, Oct 19 kept, Oct 26 rest, Nov 2 kept: 3 in a row; Nov 9 missed,
    // and this quarter's 2 rest weeks are used.
    await seedJar(db, "2026-10-05", ["2026-10-06", "2026-10-20", "2026-11-03"]);
    await db.settings.put({
      key: "streaks.rests",
      value: { set_aside: ["2026-10-12", "2026-10-26"], under_plan: [], sorted: [] },
      updated_at: "x",
    });
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const card = await setAsideCard();
    await waitFor(() => expect(card).toHaveTextContent("Fresh start"));
    expect(card).toHaveTextContent("No rest weeks left until Jan 1, 2027.");
    expect(within(card).queryByRole("button", { name: /Use a rest week/ })).toBeNull();
    expect(within(card).getByRole("button", { name: "Start again this week" })).toBeEnabled();
  });

  it("Pause streaks holds everything, and Resume the same day leaves no paused day", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-11-02", ["2026-11-03"]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    await setAsideCard();
    await user.click(await screen.findByRole("button", { name: "Pause streaks" }));
    const summary = screen.getByRole("region", { name: "Streaks summary" });
    await waitFor(() => expect(summary).toHaveTextContent("Paused"));
    expect(await setting(db, "streaks.pauses")).toEqual([{ start: "2026-11-19", end: null }]);
    await user.click(screen.getByRole("button", { name: "Resume streaks" }));
    await waitFor(() => expect(summary).not.toHaveTextContent("Paused"));
    expect(await setting(db, "streaks.pauses")).toEqual([]);
  });

  it("Your path shows the current step, and Adjust skips and renames steps", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/path");
    // Nothing set up: no cards (clear) and nothing owed (done) are reached; setup is current.
    const current = await screen.findByRole("region", { name: "Get set up" });
    expect(current).toHaveTextContent("0 of 3 set: pay, a budget and a balance");
    expect(screen.getByRole("region", { name: "Where you are" })).toHaveTextContent("2 of 7 done");
    expect(
      screen.getByText("A common order, not advice. Skip, reorder or rename any step."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust your path" });
    const showSetup = within(sheet).getAllByRole("checkbox", { name: "Show this step" })[0];
    await user.click(showSetup as HTMLElement);
    const rename = within(sheet).getByRole("textbox", { name: "Name for Starter fund" });
    await user.clear(rename);
    await user.type(rename, "First $1,000");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("region", { name: "A cushion in checking" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Where you are" })).toHaveTextContent("2 of 6 done");
    expect(screen.getByText("First $1,000")).toBeInTheDocument();
    expect(await setting(db, "path.layout")).toEqual({
      order: ["setup", "cushion", "starter", "paid_in_full", "debts", "three_months", "later"],
      skipped: ["setup"],
      names: { starter: "First $1,000" },
    });
    await waitFor(async () =>
      expect(await setting(db, "path.reached")).toEqual({
        paid_in_full: "2026-11-19",
        debts: "2026-11-19",
      }),
    );
  });

  it("milestones stamp quietly on the first reading, then celebrate a new one once", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-11-02", ["2026-11-03"], "Emergency fund", 50000);
    installFakeApi({ session: readySession() });
    renderApp("/milestones");
    const summary = await screen.findByRole("region", { name: "So far" });
    await waitFor(() => expect(summary).toHaveTextContent("1 reached"));
    await waitFor(async () =>
      expect(await setting(db, "milestones.reached")).toEqual({ first_jar: "2026-11-19" }),
    );
    expect(momentsLog.filter((m) => m.type === "badge_reached")).toEqual([]);
    const list = screen.getByRole("list", { name: "Milestones" });
    expect(within(list).getByText("$500.00 to go")).toBeInTheDocument(); // starter fund

    // $500 more makes $1,000 in the Emergency fund: the starter fund, celebrated once.
    await db.goal_events.add({
      id: "more",
      goal_id: "jar-Emergency fund",
      date: "2026-11-19",
      type: "deposit",
      amount_cents: 50000,
      created_at: "2026-11-19T12:00:00Z",
    });
    await waitFor(() => expect(summary).toHaveTextContent("2 reached"));
    await waitFor(() =>
      expect(momentsLog.filter((m) => m.type === "badge_reached")).toEqual([
        { type: "badge_reached", vars: { milestone: "Starter fund" }, seed: "badge:starter_fund" },
      ]),
    );
  });

  it("counts at most four years back, and keeps the best ever (November 20, 2026)", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    // A deposit every Tuesday from Nov 23, 2021 through Nov 17, 2026: the window starts on the
    // Monday of Nov 19, 2022 - 48 months, Nov 14, 2022, so 210 weeks count (Nov 14, 2022 through
    // Nov 16, 2026: 1,463 days, 209 steps of a week, plus the first).
    const days: string[] = [];
    for (let t = Date.UTC(2021, 10, 23); t <= Date.UTC(2026, 10, 17); t += 7 * 86400000)
      days.push(new Date(t).toISOString().slice(0, 10));
    await seedJar(db, "2021-11-22", days);
    // Another device once kept a best of 230.
    await db.settings.put({ key: "streaks.best", value: { set_aside: 230 }, updated_at: "x" });
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const card = await setAsideCard();
    await waitFor(() => expect(card).toHaveTextContent("210 weeks"));
    expect(card).toHaveTextContent("Best 230 weeks");
    expect(await setting(db, "streaks.best")).toEqual({ set_aside: 230 });
  });

  it("a longer run raises the kept best, never lowers it", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-11-02", ["2026-11-03", "2026-11-10", "2026-11-18"]);
    await db.settings.put({
      key: "streaks.best",
      value: { set_aside: 1, sorted: 9 },
      updated_at: "x",
    });
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const card = await setAsideCard();
    await waitFor(() => expect(card).toHaveTextContent("Best 3 weeks"));
    await waitFor(async () =>
      expect(await setting(db, "streaks.best")).toEqual({ set_aside: 3, sorted: 9 }),
    );
  });

  it("the $5,000 milestone reached under its old id stays reached and is not celebrated again", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-11-02", ["2026-11-03"], "Trip", 600000);
    await db.settings.put({
      key: "milestones.reached",
      value: { first_jar: "2026-11-03", jars_total: "2026-11-03" },
      updated_at: "x",
    });
    installFakeApi({ session: readySession() });
    renderApp("/milestones");
    const list = await screen.findByRole("list", { name: "Milestones" });
    await waitFor(() => expect(list).toHaveTextContent("Reached: $5,000 in jars"));
    expect(list).toHaveTextContent("Not yet: $10,000 in jars");
    expect(list).toHaveTextContent("Not yet: 4-year streak");
    expect(momentsLog.filter((m) => m.type === "badge_reached")).toEqual([]);
  });

  it("nothing about streaks, the path or milestones is ever sent", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-10-19", ["2026-10-20", "2026-10-27", "2026-11-03"]);
    const api = installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const card = await setAsideCard();
    await waitFor(() => expect(card).toHaveTextContent("Fresh start"));
    await user.click(within(card).getByRole("button", { name: "Use a rest week · keep your 3" }));
    await user.click(screen.getByRole("button", { name: "Pause streaks" }));
    await waitFor(async () => expect(await setting(db, "streaks.pauses")).toHaveLength(1));
    for (const c of api.calls) {
      expect(c.raw).not.toMatch(/streak|rest week|milestone|path\.|2026-11-09/i);
    }
  });
});
