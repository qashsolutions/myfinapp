import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, type StackdDb, seedDefaults } from "../../src/data/db.ts";
import { momentsLog } from "../../src/moments/bus.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

/**
 * Streaks when things go wrong (November 20, 2026; invariant 94): damaged saved settings, a
 * deposit dated ahead, a deposit deleted, a rest week a late deposit makes unneeded, a deposit
 * during a pause, Move money, nothing at all, a path with every step skipped or renamed to
 * nothing, a step moved to the front, an entry sorted later, a week over plan. Thursday,
 * November 19, 2026: this week starts Monday the 16th.
 */
const TODAY = new Date("2026-11-19T12:00:00");

async function seedJar(db: StackdDb, start: string, deposits: string[], title = "Trip") {
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
      amount_cents: 2000,
      created_at: `${date}T10:0${i % 10}:00Z`,
    })),
  );
  return id;
}

function entry(id: string, date: string, cents: number, category: string | null): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction: "out",
    merchant: "Shop",
    clean_description: "SHOP",
    raw_description: "SHOP",
    category_id: category,
    account_id: "acct-chk",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: `${date}T10:00:00Z`,
    updated_at: `${date}T10:00:00Z`,
  };
}

async function put(db: StackdDb, key: string, value: unknown) {
  await db.settings.put({ key, value, updated_at: "x" });
}

const card = (name: string) => screen.findByRole("region", { name });
const word = (region: HTMLElement) => region.querySelector(".word")?.textContent;

describe("streaks when things go wrong (invariant 94)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    momentsLog.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("damaged saved settings are read as empty, never a broken screen", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-11-02", ["2026-11-03", "2026-11-10", "2026-11-17"]);
    await put(db, "streaks.rests", "junk");
    await put(db, "streaks.pauses", [{ start: 5 }, "x"]);
    await put(db, "streaks.best", { set_aside: "lots", sorted: -3 });
    await put(db, "streaks.fresh_seen", 42);
    await put(db, "path.layout", 42);
    await put(db, "path.reached", ["nope"]);
    await put(db, "milestones.reached", "nope");
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const aside = await card("Set aside");
    await waitFor(() => expect(word(aside)).toBe("3 weeks"));
    expect(aside).toHaveTextContent("Best 3 weeks");
    expect(await screen.findByRole("link", { name: "Your path, open Your path" })).toBeVisible();
  });

  it("a deposit dated ahead never counts for a week that hasn't come", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-11-16", ["2026-11-24"]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const aside = await card("Set aside");
    await waitFor(() => expect(word(aside)).toBe("Start"));
  });

  it("deleting a deposit lowers the run, and the best stays", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const jar = await seedJar(db, "2026-11-02", ["2026-11-03", "2026-11-10", "2026-11-17"]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const aside = await card("Set aside");
    await waitFor(() => expect(word(aside)).toBe("3 weeks"));
    await waitFor(async () =>
      expect((await db.settings.get("streaks.best"))?.value).toEqual({ set_aside: 3 }),
    );
    await db.goal_events.delete(`${jar}-d1`); // Nov 10 gone: Nov 9's week is missed
    await waitFor(() => expect(word(aside)).toBe("1 week"));
    expect(aside).toHaveTextContent("Best 3 weeks");
  });

  it("a rest week a late deposit makes unneeded is not used up", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const jar = await seedJar(db, "2026-10-26", ["2026-10-27", "2026-11-03"]);
    await put(db, "streaks.rests", { set_aside: ["2026-11-09"], under_plan: [], sorted: [] });
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const aside = await card("Set aside");
    await waitFor(() =>
      expect(within(aside).getByRole("img")).toHaveAccessibleName(/2 kept, 1 rest/),
    );
    // The deposit for Nov 9's week is logged late: that week is kept, the rest is not spent.
    await db.goal_events.add({
      id: "late",
      goal_id: jar,
      date: "2026-11-11",
      type: "deposit",
      amount_cents: 2000,
      created_at: "2026-11-19T09:00:00Z",
    });
    await waitFor(() => expect(within(aside).getByRole("img")).toHaveAccessibleName(/: 3 kept$/));
    expect(word(aside)).toBe("3 weeks");
  });

  it("a deposit during a pause still counts", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await seedJar(db, "2026-11-02", ["2026-11-03", "2026-11-10"]);
    await put(db, "streaks.pauses", [{ start: "2026-11-09", end: "2026-11-15" }]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const aside = await card("Set aside");
    await waitFor(() => expect(word(aside)).toBe("2 weeks"));
  });

  it("moving money between jars sets nothing new aside", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const a = await seedJar(db, "2026-11-02", ["2026-11-03"], "Trip");
    const b = await seedJar(db, "2026-11-02", [], "Car");
    // Move money this week: a withdrawal and a deposit written together.
    const at = "2026-11-17T09:00:00Z";
    await db.goal_events.bulkAdd([
      {
        id: "w",
        goal_id: a,
        date: "2026-11-17",
        type: "withdrawal",
        amount_cents: 1000,
        created_at: at,
      },
      {
        id: "dp",
        goal_id: b,
        date: "2026-11-17",
        type: "deposit",
        amount_cents: 1000,
        created_at: at,
      },
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const aside = await card("Set aside");
    // Nov 2's week was kept, Nov 9 missed, and this week has only a move: not kept, so the
    // missed week still reads as a Fresh start.
    await waitFor(() => expect(word(aside)).toBe("Fresh start"));
    expect(within(aside).getByRole("img")).toHaveAccessibleName(/1 kept, 1 not kept/);
  });

  it("with nothing yet: no streak cards, Home's card hidden, the path still there", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const summary = await card("Streaks summary");
    await waitFor(() =>
      expect(summary).toHaveTextContent("Put money in a jar to start your first streak."),
    );
    expect(screen.queryByRole("region", { name: "Set aside" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause streaks" })).toBeNull();
    expect(await screen.findByRole("link", { name: "Your path, open Your path" })).toBeVisible();
  });

  it("a step renamed to nothing keeps its own name; every step skipped says so", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/path");
    await screen.findByRole("region", { name: "Where you are" });
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust your path" });
    await user.click(within(sheet).getByRole("button", { name: "Rename Starter fund" }));
    await user.clear(within(sheet).getByRole("textbox", { name: "Name for Starter fund" }));
    for (const box of within(sheet).getAllByRole("checkbox", { name: "Show this step" }))
      await user.click(box);
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    const where = await screen.findByRole("region", { name: "Where you are" });
    await waitFor(() => expect(where).toHaveTextContent("Skipped"));
    expect(where).toHaveTextContent("Every step is skipped. Adjust to show some.");
    expect(screen.getByText("Starter fund")).toBeInTheDocument();
    const saved = (await db.settings.get("path.layout"))?.value as { names: object };
    expect(saved.names).toEqual({});
  });

  it("a step moved to the front becomes the next one", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/path");
    await screen.findByRole("region", { name: "Get set up" });
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust your path" });
    await user.click(within(sheet).getByRole("button", { name: "Move Starter fund up" }));
    await user.click(within(sheet).getByRole("button", { name: "Move Starter fund up" }));
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("region", { name: "Starter fund" })).toHaveTextContent(
      "$0.00 of $1,000.00 in Emergency fund",
    );
    expect(screen.getByRole("region", { name: "Where you are" })).toHaveTextContent(
      "Next: Starter fund",
    );
  });

  it("an entry sorted later completes its week", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("a", "2026-11-03", 500, "cat-groceries"),
      entry("b", "2026-11-10", 500, null),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const sorted = await card("Sorted");
    // Nov 2 kept, Nov 9 has an unsorted entry: a Fresh start after a run of 1.
    await waitFor(() => expect(word(sorted)).toBe("Fresh start"));
    await db.entries.update("b", { category_id: "cat-groceries" });
    await waitFor(() => expect(word(sorted)).toBe("2 weeks"));
  });

  it("a week over plan breaks Under plan, plainly", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    // 50/30/20 on $3,000: needs + wants $2,400 for November; by the 15th $1,200 is on pace.
    await db.budgets.add({
      id: "b",
      month: "2026-11",
      method: "50_30_20",
      take_home_cents: 300000,
      created_at: "2026-11-01T00:00:00Z",
      updated_at: "2026-11-01T00:00:00Z",
    });
    await db.entries.bulkAdd([
      entry("e1", "2026-10-27", 100, "cat-groceries"),
      entry("e2", "2026-11-12", 130000, "cat-groceries"),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/goals?tab=streaks");
    const under = await card("Under plan");
    // Weeks of Oct 26 and Nov 2 on pace; Nov 9 at $1,300 against $1,200 is over.
    await waitFor(() => expect(word(under)).toBe("Fresh start"));
    expect(under.querySelector(".word")).toHaveClass("word--plain");
    expect(under).toHaveTextContent("Your best stays 2 weeks.");
  });
});
