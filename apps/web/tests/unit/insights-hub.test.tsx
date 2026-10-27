import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function entry(
  id: string,
  cents: number,
  direction: "in" | "out",
  category: string | null,
  transfer = false,
): Entry {
  const stamp = "2026-10-05T10:00:00.000Z";
  return {
    id,
    date: "2026-10-05",
    amount_cents: cents,
    direction,
    merchant: id,
    clean_description: id,
    raw_description: null,
    category_id: category,
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: transfer,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: stamp,
    updated_at: stamp,
  };
}

describe("Insights (owner decision, October 18, 2026: replaces Learn's articles)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a summary card per area with a headline and a short line, each opening its detail", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("pay", 300000, "in", "cat-paycheck"),
      entry("rent", 150000, "out", "cat-rent"),
      entry("mystery", 2500, "out", null),
      entry("move", 50000, "out", null, true), // a transfer isn't spending to sort
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    expect(await screen.findByRole("heading", { level: 1, name: "Insights" })).toBeInTheDocument();

    const money = await screen.findByRole("link", { name: "Money in & out" });
    await waitFor(() => expect(money).toHaveTextContent("$1,475.00 kept"));
    // One word of value first (owner, October 25, 2026), then the short line
    expect(within(money).getByText("Kept")).toHaveClass("insight-card__word--good");

    const sorted = screen.getByRole("link", { name: "Auto-sorted spending" });
    await waitFor(() => expect(sorted).toHaveTextContent("67% sorted"));
    expect(within(sorted).getByText("1 to review")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Bills & subscriptions" })).toHaveTextContent(
      "No bills tracked yet",
    );
    expect(screen.getByRole("link", { name: "Safe to spend" })).toHaveTextContent(
      /Add your balance|Working it out/,
    );
    expect(screen.getByRole("link", { name: "Budget & jars" })).toHaveTextContent(
      "Set your budget",
    );
    // Every card leads with exactly one word, and every line stays short: eight words at most
    for (const word of document.querySelectorAll(".insight-card__headline"))
      expect(word.textContent ?? "").toMatch(/^\S+$/);
    for (const line of document.querySelectorAll(".insight-card__line"))
      expect((line.textContent ?? "").split(/\s+/).length).toBeLessThanOrEqual(8);

    // The growth illustration became Later: savings by the age you choose ($200 a month from
    // 35 to 67 at the middle 5% is $188,956.58)
    const later = screen.getByRole("link", { name: "Later" });
    await waitFor(() => expect(later).toHaveTextContent("$189k at 67"));
    // No articles
    expect(screen.queryByRole("list", { name: "Articles" })).toBeNull();

    await user.click(money);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Money in & out" }),
    ).toBeInTheDocument();
  });

  it("old Learn links land on Insights", async () => {
    installFakeApi({ session: readySession() });
    renderApp("/learn/how-cds-work");
    expect(await screen.findByRole("heading", { level: 1, name: "Insights" })).toBeInTheDocument();
  });
});

describe("arranging any screen (October 25, 2026)", () => {
  it("moves and switches off Insights cards through the shared sheet, and keeps the choice", async () => {
    const user = userEvent.setup();
    await seedDefaults(openDb("u1"));
    installFakeApi({ session: readySession() });
    renderApp("/insights");
    await screen.findByRole("link", { name: "Later" });
    await user.click(screen.getByRole("button", { name: "Customize Insights" }));
    const sheet = await screen.findByRole("dialog", { name: "Customize Insights" });
    await user.click(within(sheet).getByRole("button", { name: "Move Net worth up" }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Net worth moved to 6 of 8");
    await user.click(within(sheet).getByRole("switch", { name: /Later/ }));
    await user.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Later" })).toBeNull());
    const titles = screen
      .getAllByRole("link")
      .map((l) => l.getAttribute("aria-label"))
      .filter((t) => t === "Net worth" || t === "Budget & jars");
    expect(titles).toEqual(["Net worth", "Budget & jars"]);
    const saved = (await openDb("u1").settings.get("insights.layout"))?.value;
    expect(saved).toMatchObject({ hidden: ["later"] });
  });
});
