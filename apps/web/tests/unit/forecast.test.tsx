import { RULES_VERSION } from "@stackd/rules";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction,
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: direction === "out" ? "cat-dining" : null,
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
  };
}

async function seedHistory(withAnchor: boolean) {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.entries.bulkAdd([
    entry("n1", "2026-07-14", 1549, "Netflix.com"),
    entry("n2", "2026-08-14", 1549, "Netflix.com"),
    entry("n3", "2026-09-14", 1549, "Netflix.com"),
    entry("r1", "2026-07-25", 165000, "Rent"),
    entry("r2", "2026-08-25", 165000, "Rent"),
    entry("r3", "2026-09-25", 165000, "Rent"),
    entry("g1", "2026-07-20", 3000, "Gym"),
    entry("g2", "2026-08-20", 3000, "Gym"),
    entry("g3", "2026-09-20", 3000, "Gym"),
    entry("p1", "2026-09-04", 240000, "ACME PAYROLL", "in"),
    entry("p2", "2026-09-18", 240000, "ACME PAYROLL", "in"),
    entry("p3", "2026-10-02", 240000, "ACME PAYROLL", "in"),
    entry("x1", "2026-10-08", 4500, "Corner Market"),
    entry("x2", "2026-09-10", 27000, "Shoes"),
  ]);
  if (withAnchor) {
    await db.balance_anchors.add({
      id: "anchor-1",
      account_id: "acct-cash",
      as_of: "2026-10-05",
      balance_cents: 210000,
      source: "statement",
      created_at: "2026-10-05T00:00:00Z",
    });
  }
  return db;
}

describe("Upcoming + forecast", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows bills and paydays on a calendar, and a day's items and balance when tapped", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const db = await seedHistory(true);
    const base = { source: "manual" as const, account_id: null, status: "confirmed" as const };
    const stamp = "2026-10-01T00:00:00Z";
    await db.recurring_series.bulkAdd([
      {
        ...base,
        id: "s-rent",
        payee: "RENT",
        label: "Rent",
        kind: "bill",
        expected_cents: 165000,
        interval: "monthly",
        next_date: "2026-10-25",
        created_at: stamp,
        updated_at: stamp,
      },
      {
        ...base,
        id: "s-pay",
        payee: "ACME PAYROLL",
        label: "Acme payroll",
        kind: "income",
        expected_cents: 240000,
        interval: "biweekly",
        next_date: "2026-10-16",
        created_at: stamp,
        updated_at: stamp,
      },
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/forecast");
    const upcoming = await screen.findByRole("region", { name: "Upcoming" });
    await user.click(await within(upcoming).findByRole("radio", { name: "Calendar" }));
    expect(localStorage.getItem("stackd.upcoming.view")).toBe("calendar");
    const grid = within(upcoming).getByRole("table");
    const rent = within(grid).getByRole("button", {
      name: /^Oct 25: Rent −\$1,650\.00, estimated balance/,
    });
    expect(
      within(grid).getByRole("button", { name: /^Oct 16: Acme payroll \+\$2,400\.00/ }),
    ).toBeInTheDocument();
    expect(
      within(grid).getByRole("button", { name: /^Oct 11, nothing due|^Oct 11: estimated balance/ }),
    ).toBeInTheDocument();
    await user.click(rent);
    expect(rent).toHaveAttribute("aria-pressed", "true");
    expect(within(upcoming).getByText(/left that day/)).toBeInTheDocument();
    expect(within(upcoming).getByText("Rent")).toBeInTheDocument();
  });

  it("suggests recurring payees, confirms bills and income, adds one by hand, then forecasts 30 days", async () => {
    const user = userEvent.setup();
    const db = await seedHistory(true);
    installFakeApi({ session: readySession() });
    renderApp("/bills");
    await screen.findByRole("navigation", { name: "Primary" });

    const rent = await screen.findByRole("region", { name: "Suggestion: Rent" });
    expect(rent).toHaveTextContent("Rent · $1,650.00 monthly");
    expect(rent).toHaveTextContent("next ~Oct 25");
    await user.click(within(rent).getByRole("button", { name: "Yes, it's a bill" }));
    const netflix = await screen.findByRole("region", { name: "Suggestion: Netflix.com" });
    await user.click(within(netflix).getByRole("button", { name: "Yes, it's a bill" }));
    const pay = await screen.findByRole("region", { name: "Suggestion: ACME PAYROLL" });
    expect(pay).toHaveTextContent("$2,400.00 every 2 weeks");
    await user.click(within(pay).getByRole("button", { name: "Yes, it's income" }));
    const gym = await screen.findByRole("region", { name: "Suggestion: Gym" });
    await user.click(within(gym).getByRole("button", { name: "Not a bill" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /Suggestion:/ })).toBeNull());

    const list = await screen.findByRole("list", { name: "Bills and income" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Netflix.com");

    // Add a bill by hand
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a bill or income" });
    await user.type(within(sheet).getByLabelText("Name"), "Car insurance");
    await user.type(within(sheet).getByLabelText("Amount"), "180");
    fireEvent.change(within(sheet).getByLabelText("Next date"), {
      target: { value: "2026-10-14" },
    });
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));

    const series = await db.recurring_series.toArray();
    expect(series.filter((s) => s.status === "confirmed")).toHaveLength(4);
    expect(series.find((s) => s.payee === "GYM")?.status).toBe("dismissed");
    expect(series.find((s) => s.payee === "CAR INSURANCE")).toMatchObject({
      source: "manual",
      expected_cents: 18000,
      next_date: "2026-10-14",
    });
    const flagged = (await db.entries.filter((e) => e.is_recurring).toArray())
      .map((e) => e.id)
      .sort();
    expect(flagged).toEqual(["n1", "n2", "n3", "p1", "p2", "p3", "r1", "r2", "r3"]);

    // The forecast: start $2,055.00 (anchor $2,100 on Oct 5 − $45 since), $4.50 a day
    // (non-recurring $405 over 90 days), Netflix + car insurance Oct 14, pay Oct 16 and 30, rent Oct 25
    await user.click(screen.getByRole("link", { name: "Back" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Next 30 days" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Lowest $1,837.01 · Oct 15")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Shortfall" })).toBeNull();
    const upcoming = screen.getByRole("region", { name: "Upcoming" });
    const rows = within(upcoming)
      .getAllByText(/Bill · |Income · /)
      .map((el) => el.parentElement?.parentElement?.textContent ?? "");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("Oct 14");
    expect(rows[0]).toContain("Car insurance");
    expect(rows[1]).toContain("Netflix.com");
    expect(rows[2]).toContain("Oct 16");
    expect(rows[2]).toContain("ACME PAYROLL");
    expect(rows[2]).toContain("$2,400.00");
    expect(rows[3]).toContain("Rent");
    expect(rows[3]).toContain("$1,650.00");
    expect(rows[4]).toContain("Oct 30");
    expect(screen.getByRole("img", { name: /Lowest \$1,837\.01 on Oct 15/ })).toBeInTheDocument();
    const stored = await db.forecasts.get("2026-10-10");
    expect(stored).toMatchObject({
      lowest_cents: 183701,
      lowest_date: "2026-10-15",
      shortfall: false,
      rules_version: RULES_VERSION,
    });

    // A $2,500 buffer: today's $2,055 is already under it, and the dip is $662.99 below
    await user.click(screen.getByRole("button", { name: "Cushion $0.00" }));
    const buffer = await screen.findByRole("dialog", { name: "Your cushion" });
    await user.type(within(buffer).getByLabelText("Cushion"), "2500");
    await user.click(within(buffer).getByRole("button", { name: "Save cushion" }));
    const warn = await screen.findByRole("region", { name: "Shortfall" });
    // Each number with its own date: first under the buffer Oct 10, deepest Oct 15
    expect(warn).toHaveTextContent("Below your cushion from Oct 10, short up to $662.99 by Oct 15");
  });

  it("asks for a balance when there is no anchor, then forecasts from the entered one; Home shows the card", async () => {
    const user = userEvent.setup();
    const db = await seedHistory(false);
    installFakeApi({ session: readySession() });
    renderApp("/forecast");
    await screen.findByRole("navigation", { name: "Primary" });
    const ask = await screen.findByRole("region", { name: "Balance needed" });
    expect(screen.queryByRole("region", { name: "Estimated balance" })).toBeNull();
    await user.click(within(ask).getByRole("button", { name: "Enter a balance" }));
    const sheet = await screen.findByRole("dialog", { name: /Balance in/ });
    await user.type(within(sheet).getByLabelText("Balance"), "2,000");
    await user.click(within(sheet).getByRole("button", { name: "Save balance" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Estimated balance" })).toBeInTheDocument(),
    );
    // No confirmed series: everything is ordinary spending, $5,401.47 over 90 days = $60.02 a day,
    // so $2,000 falls to $199.40 by Nov 9
    await waitFor(() => expect(screen.getByText(/^Lowest \$199\.40 · Nov 9$/)).toBeInTheDocument());
    const anchors = await db.balance_anchors.toArray();
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      account_id: "acct-cash",
      balance_cents: 200000,
      source: "user",
      as_of: "2026-10-10",
    });

    renderApp("/");
    const card = await screen.findByRole("link", { name: "Open the next 30 days" });
    await waitFor(() =>
      expect(card).toHaveTextContent("Lowest $199.40 around Nov 9 · no shortfall expected"),
    );
  });

  it("says Covered in one word, marks pay and bills, redraws for a what-if, and looks a year ahead", async () => {
    const db = await seedHistory(true);
    const at = "2026-10-01T00:00:00Z";
    await db.recurring_series.bulkAdd([
      {
        id: "s-pay",
        payee: "ACME PAYROLL",
        label: "ACME PAYROLL",
        kind: "income",
        expected_cents: 240000,
        interval: "biweekly",
        next_date: "2026-10-16",
        status: "confirmed",
        source: "detected",
        account_id: null,
        created_at: at,
        updated_at: at,
      },
      {
        id: "s-rent",
        payee: "RENT",
        label: "Rent",
        kind: "bill",
        expected_cents: 165000,
        interval: "monthly",
        next_date: "2026-10-25",
        status: "confirmed",
        source: "detected",
        account_id: null,
        created_at: at,
        updated_at: at,
      },
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/forecast");
    const covered = await screen.findByRole("region", { name: "Covered" });
    expect(within(covered).getByRole("heading", { name: "Covered" })).toBeInTheDocument();
    expect(covered).toHaveTextContent(/Never below zero\./);
    expect(
      await screen.findByRole("img", { name: /2 paydays and 1 bill marked/ }),
    ).toBeInTheDocument();

    const tryCard = screen.getByRole("region", { name: "What if" });
    fireEvent.change(within(tryCard).getByRole("slider", { name: /Spend less each day/ }), {
      target: { value: "1000" },
    });
    const verdict = await within(tryCard).findByRole("status");
    expect(verdict).toHaveTextContent("Covered");
    expect(verdict).toHaveTextContent(/\(up \$/);
    fireEvent.change(within(tryCard).getByRole("slider", { name: /Set aside each payday/ }), {
      target: { value: "10000" },
    });
    await waitFor(() => expect(verdict).toHaveTextContent("$200.00 set aside by Nov 9"));
    expect(screen.getByRole("img", { name: /Estimated balance/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Year" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Next year" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /over the next 365 days/ })).toBeInTheDocument();
    // Only the 30-day forecast is stored for Home and alerts.
    expect((await db.forecasts.get("2026-10-10"))?.payload).toBeDefined();
  });

  it("drops the what-if line when the Try card is hidden, so the chart never keeps a stale one", async () => {
    const db = await seedHistory(true);
    await db.recurring_series.add({
      id: "s-pay",
      payee: "ACME PAYROLL",
      label: "ACME PAYROLL",
      kind: "income",
      expected_cents: 240000,
      interval: "biweekly",
      next_date: "2026-10-16",
      status: "confirmed",
      source: "detected",
      account_id: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/forecast");
    const tryCard = await screen.findByRole("region", { name: "What if" });
    fireEvent.change(within(tryCard).getByRole("slider", { name: /Spend less each day/ }), {
      target: { value: "1000" },
    });
    await within(tryCard).findByRole("status");
    const chart = () => screen.getByRole("img", { name: /Estimated balance/ }).closest("div");
    await waitFor(() => expect(screen.getByText("What if")).toBeInTheDocument());
    // Hidden through Customize (the saved layout): the dashed line and its key go with it.
    await db.settings.put({
      key: "forecast.layout",
      value: {
        order: ["status", "balance", "try", "upcoming", "bigger"],
        hidden: ["try"],
      },
      updated_at: new Date().toISOString(),
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "What if" })).toBeNull());
    await waitFor(() => expect(screen.queryByText("What if")).toBeNull());
    expect(chart()).toBeTruthy();
  });
});
