import { RULES_VERSION } from "@stackd/rules";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

async function renderSignedIn(path: string) {
  installFakeApi({ session: readySession() });
  renderApp(path);
  await screen.findByRole("navigation", { name: "Primary" });
}

describe("Goals", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a jar from the sentence, shows the weekly pace, logs deposits, reaches it", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/goals");
    expect(await screen.findByText(/No goals yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "+ New" }));
    expect(await screen.findByRole("heading", { level: 1, name: "New goal" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Save (jar)" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Change amount" })).toHaveTextContent("$2,000.00");
    expect(screen.getByRole("button", { name: "Change what it's for" })).toHaveTextContent(
      "Travel",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change deadline" })).toHaveTextContent(
        "Apr 10, 2027",
      ),
    );
    // 6 months out = 182 days = 26 weeks -> $2,000 / 26 = $76.92 a week
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("$76.92 a week · 26 weeks to $2,000.00"),
    );

    await user.click(screen.getByRole("button", { name: "Change amount" }));
    const amountSheet = await screen.findByRole("dialog", { name: "How much?" });
    await user.click(within(amountSheet).getByRole("radio", { name: "$5,000.00" }));
    await user.click(within(amountSheet).getByRole("button", { name: "Use this" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "$192.31 a week · 26 weeks to $5,000.00",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Change what it's for" }));
    const whatSheet = await screen.findByRole("dialog", { name: "What's it for?" });
    await user.click(within(whatSheet).getByRole("radio", { name: "Emergency fund" }));
    await user.click(within(whatSheet).getByRole("button", { name: "Use this" }));
    await user.click(screen.getByRole("button", { name: "Create jar" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Emergency fund" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This records it in Qash. Your money stays where it is."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("img", { name: "0 percent" })).toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: "+$192.31" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "4 percent" })).toBeInTheDocument());
    await user.type(screen.getByLabelText("Other amount"), "4,807.69");
    await user.click(screen.getByRole("button", { name: "Log" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "100 percent" })).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole("region", { name: "Progress" })).getByText("Reached"),
    ).toBeInTheDocument();
    const recent = screen.getByRole("region", { name: "Recent" });
    expect(within(recent).getAllByText(/^\+\$/)).toHaveLength(2);

    const db = openDb("u1");
    expect(await db.goals.count()).toBe(1);
    expect(await db.goal_events.count()).toBe(2);
    const stored = (await db.computed_results.toArray()).find((r) => r.kind === "goal_progress");
    expect(stored).toMatchObject({ rules_version: RULES_VERSION });

    await user.click(screen.getByRole("link", { name: "Back" }));
    // A reached jar is folded under Reached and frees its slot on the plan.
    const reached = await screen.findByRole("list", { name: "Reached" });
    const row = within(reached).getByRole("link", { name: /Emergency fund/ });
    await waitFor(() => expect(row).toHaveTextContent("$5,000.00 of $5,000.00"));
    expect(row).toHaveTextContent("Reached");
    expect((await db.goals.toArray())[0]?.status).toBe("reached");
    // Finished jars still count; moving one to templates frees its place.
    expect(screen.getByText(/^Using 1 of \d+ on your plan$/)).toBeInTheDocument();
    await user.click(row);
    await user.click(await screen.findByRole("button", { name: "Move to my templates" }));
    const sheet = await screen.findByRole("dialog", { name: "Save as my template" });
    expect(
      within(sheet).getByRole("switch", { name: /Remove this jar after saving/ }),
    ).toBeChecked();
    await user.click(within(sheet).getByRole("button", { name: "Save and remove jar" }));
    expect(await screen.findByText(/^Using 0 of \d+ on your plan$/)).toBeInTheDocument();
    expect((await db.goals.toArray())[0]?.status).toBe("archived");
    expect((await db.goal_templates.toArray()).map((t) => t.name)).toEqual(["Emergency fund"]);
  });

  it("pay off: the latest balance drives progress", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/goals/new");
    await user.click(await screen.findByRole("radio", { name: "Pay off" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change what it's for" })).toHaveTextContent(
        "Credit card",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Create goal" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Credit card" }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Current balance"), "1,500");
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "25 percent" })).toBeInTheDocument(),
    );
    vi.setSystemTime(new Date("2026-10-10T12:05:00"));
    await user.type(screen.getByLabelText("Current balance"), "1,800");
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "10 percent" })).toBeInTheDocument(),
    );
  });

  it("spend less: needs a usual spend, then measures against this month's entries", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add({
      id: "d1",
      date: "2026-10-03",
      amount_cents: 28400,
      direction: "out",
      merchant: "Dining",
      clean_description: "DINING",
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
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
    });
    await renderSignedIn("/goals/new");
    await user.click(await screen.findByRole("radio", { name: "Spend less" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change category" })).toHaveTextContent("Dining"),
    );
    expect(screen.getByRole("button", { name: "Change amount" })).toHaveTextContent("$150.00");
    await user.click(screen.getByRole("button", { name: "Create goal" }));
    const sheet = await screen.findByRole("dialog", {
      name: /What do you usually spend on Dining/,
    });
    await user.type(within(sheet).getByLabelText("Usual monthly spend"), "380");
    await user.click(within(sheet).getByRole("button", { name: "Use this" }));
    await waitFor(() =>
      expect(screen.getByText(/Against your usual \$380\.00 a month/)).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Create goal" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Dining" })).toBeInTheDocument();
    // baseline 380 − spent 284 = $96 saved of $150 = 64%
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "64 percent" })).toBeInTheDocument(),
    );
    expect(screen.getByText(/\$96\.00 saved so far/)).toBeInTheDocument();
  });

  it("habit: one check-in a day", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/goals/new");
    await user.click(await screen.findByRole("radio", { name: "Habit" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change days" })).toHaveTextContent("7 days"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("7 check-ins, one a day");
    await user.click(screen.getByRole("button", { name: "Create goal" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "no eating out" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Check in for today" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "14 percent" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Checked in today" })).toBeDisabled();
    expect(await openDb("u1").goal_events.count()).toBe(1);
  });
  it("custom jar: own name, any amount, any date; a past date is refused", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/goals/new");
    await screen.findByRole("heading", { level: 1, name: "New goal" });

    await user.click(screen.getByRole("button", { name: "Change what it's for" }));
    const whatSheet = await screen.findByRole("dialog", { name: "What's it for?" });
    await user.type(within(whatSheet).getByLabelText("Or name your own"), "  New laptop ");
    await user.click(within(whatSheet).getByRole("button", { name: "Use this" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change what it's for" })).toHaveTextContent(
        "New laptop",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Change amount" }));
    const amountSheet = await screen.findByRole("dialog", { name: "How much?" });
    await user.type(within(amountSheet).getByLabelText("Or any amount"), "1,500");
    await user.click(within(amountSheet).getByRole("button", { name: "Use this" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change amount" })).toHaveTextContent("$1,500.00"),
    );

    await user.click(screen.getByRole("button", { name: "Change deadline" }));
    const whenSheet = await screen.findByRole("dialog", { name: "By when?" });
    const dateInput = within(whenSheet).getByLabelText("Or pick a date");
    fireEvent.change(dateInput, { target: { value: "2026-10-09" } });
    await user.click(within(whenSheet).getByRole("button", { name: "Use this" }));
    expect(await within(whenSheet).findByRole("alert")).toHaveTextContent(
      "Pick a date after today.",
    );
    fireEvent.change(dateInput, { target: { value: "2027-01-10" } });
    await user.click(within(whenSheet).getByRole("button", { name: "Use this" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change deadline" })).toHaveTextContent(
        "Jan 10, 2027",
      ),
    );
    // Oct 10 -> Jan 10 = 92 days = 14 weeks -> $1,500 / 14 = $107.14 a week
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "$107.14 a week · 14 weeks to $1,500.00",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Create jar" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "New laptop" }),
    ).toBeInTheDocument();
    const stored = await openDb("u1").goals.toArray();
    expect(stored[0]).toMatchObject({
      kind: "save",
      title: "New laptop",
      target_cents: 150000,
      end_date: "2027-01-10",
    });
  });

  it("custom name: an 11-character name is refused and the preset stays", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/goals/new");
    await screen.findByRole("heading", { level: 1, name: "New goal" });
    await user.click(screen.getByRole("button", { name: "Change what it's for" }));
    const whatSheet = await screen.findByRole("dialog", { name: "What's it for?" });
    await user.type(within(whatSheet).getByLabelText("Or name your own"), "a".repeat(11));
    await user.click(within(whatSheet).getByRole("button", { name: "Use this" }));
    expect(await within(whatSheet).findByRole("alert")).toHaveTextContent(
      "Give it a name, up to 10 characters.",
    );
    expect(screen.getByRole("button", { name: "Change what it's for" })).toHaveTextContent(
      "Travel",
    );
  });
});
