import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { createBudget } from "../../src/features/budget/useBudget.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function fakePushBrowser() {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    toJSON: () => ({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "p", auth: "a" },
    }),
    unsubscribe: async () => true,
  };
  const pushManager = {
    getSubscription: vi.fn(async () => null),
    subscribe: vi.fn(async () => subscription),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve({ pushManager }) },
    configurable: true,
  });
  Object.defineProperty(window, "PushManager", {
    value: function PushManager() {},
    configurable: true,
  });
  Object.defineProperty(window, "Notification", {
    value: { requestPermission: vi.fn(async () => "granted") },
    configurable: true,
  });
  return { pushManager, subscription };
}

describe("Notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets low balance, milestones and group activity wait for one daily summary", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/me/notifications");
    const item = await screen.findByText("Milestone reached", { selector: ".sk-row__label" });
    const row = item.closest("li") as HTMLElement;
    expect(row).toHaveTextContent("When a jar hits a milestone · as it happens");
    const options = within(row).getByRole("group", { name: "Milestone reached options" });
    expect(within(options).getByRole("radio", { name: "As it happens" })).toBeChecked();
    await user.click(within(options).getByRole("radio", { name: "One daily summary" }));
    await waitFor(() =>
      expect(row).toHaveTextContent("When a jar hits a milestone · one summary daily at 7:00 pm"),
    );
    const time = within(options).getByLabelText("Summary time");
    await user.clear(time);
    await user.type(time, "18:30");
    await user.tab();
    await waitFor(() => expect(row).toHaveTextContent("one summary daily at 6:30 pm"));
    const puts = api.calls.filter(
      (c) => c.method === "PUT" && c.path === "/api/notifications/settings",
    );
    expect(puts.map((c) => c.body)).toEqual([
      { prefs: { milestone_reached: { delivery: "daily" } } },
      { prefs: { milestone_reached: { time_of_day: "18:30" } } },
    ]);
    // Bills keep their own timing; only the three event alerts offer the summary
    const bills = screen
      .getByText("Upcoming expense", { selector: ".sk-row__label" })
      .closest("li") as HTMLElement;
    expect(within(bills).queryByRole("radio", { name: "One daily summary" })).toBeNull();
  });

  it("shows every type with its switch, saves changes, and turns push on after the explainer", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const browser = fakePushBrowser();
    renderApp("/me/notifications");
    await screen.findByRole("navigation", { name: "Primary" });
    const list = await screen.findByRole("list", { name: "Alert types" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(within(list).getByRole("switch", { name: "Group activity alerts" })).not.toBeChecked();
    await user.click(within(list).getByRole("switch", { name: "Group activity alerts" }));
    await waitFor(() =>
      expect(within(list).getByRole("switch", { name: "Group activity alerts" })).toBeChecked(),
    );
    expect(
      api.calls.find((c) => c.method === "PUT" && c.path === "/api/notifications/settings")?.body,
    ).toEqual({ prefs: { group_activity: { enabled: true } } });
    await user.click(screen.getByRole("radio", { name: "5" }));
    await waitFor(() =>
      expect(screen.getByText("5 · extras go in one summary")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "1 week" }));
    await waitFor(() => expect(screen.getByText(/Paused until/)).toBeInTheDocument());
    expect(screen.getByText("Security alerts are always on")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Turn on notifications" }));
    const sheet = await screen.findByRole("dialog", { name: "Stay on track" });
    expect(sheet).toHaveTextContent("No spam, no marketing");
    await user.click(within(sheet).getByRole("button", { name: "Turn on notifications" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Notifications are on."),
    );
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const posted = api.calls.find(
      (c) => c.method === "POST" && c.path === "/api/notifications/push",
    )?.body as Record<string, unknown>;
    expect(posted).toMatchObject({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "p", auth: "a" },
    });
    expect(Object.keys(posted).sort()).toEqual(["endpoint", "keys", "user_agent"]);
    await waitFor(() => expect(screen.getByText(/Push is on/)).toBeInTheDocument());
  });

  async function openPrompt(user: ReturnType<typeof userEvent.setup>) {
    renderApp("/me/notifications");
    await screen.findByRole("list", { name: "Alert types" });
    await user.click(screen.getByRole("button", { name: "Turn on notifications" }));
    return screen.findByRole("dialog", { name: "Stay on track" });
  }

  it("a private window's refusal says what happened and what to try (invariant 63)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const browser = fakePushBrowser();
    // Chrome's private window: the permission is already "denied" and nothing is ever asked.
    Object.defineProperty(window, "Notification", {
      value: { permission: "denied", requestPermission: vi.fn(async () => "denied") },
      configurable: true,
    });
    const sheet = await openPrompt(user);
    await user.click(within(sheet).getByRole("button", { name: "Turn on notifications" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "This browser didn't allow notifications. Private windows can't get them: try a normal window, or check the browser's site settings.",
    );
    // Nothing another tap could change: no spinner, no disabled button, a way out.
    expect(within(sheet).queryByRole("button", { name: /Turn on|Try again/ })).toBeNull();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.calls.filter((c) => c.path === "/api/notifications/push")).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Private windows can't get them");
  });

  it("a push service that throws, then answers, ends in a message and a working Try again (invariant 63)", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    const browser = fakePushBrowser();
    browser.pushManager.subscribe.mockRejectedValueOnce(
      new DOMException("Registration failed - push service not available", "AbortError"),
    );
    const sheet = await openPrompt(user);
    await user.click(within(sheet).getByRole("button", { name: "Turn on notifications" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "The browser's push service didn't answer.",
    );
    const again = within(sheet).getByRole("button", { name: "Try again" });
    expect(again).toBeEnabled();
    await user.click(again);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Notifications are on.");
  });

  it("answering Block, and going offline before the device is saved, each say so (invariant 63)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    fakePushBrowser();
    const ask = vi.fn(async () => "denied");
    Object.defineProperty(window, "Notification", {
      value: { permission: "default", requestPermission: ask },
      configurable: true,
    });
    const sheet = await openPrompt(user);
    await user.click(within(sheet).getByRole("button", { name: "Turn on notifications" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "Notifications are blocked for this site.",
    );
    expect(ask).toHaveBeenCalledTimes(1);
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    Object.defineProperty(window, "Notification", {
      value: { permission: "default", requestPermission: vi.fn(async () => "granted") },
      configurable: true,
    });
    await user.click(screen.getByRole("button", { name: "Turn on notifications" }));
    const again = await screen.findByRole("dialog", { name: "Stay on track" });
    api.offline = true;
    await user.click(within(again).getByRole("button", { name: "Turn on notifications" }));
    expect(await within(again).findByRole("alert")).toHaveTextContent(
      "You're offline. Try again when connected.",
    );
    expect(within(again).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("lets the weekly recap arrive by push, email or both", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/me/notifications");
    const list = await screen.findByRole("list", { name: "Alert types" });
    const row = within(list).getByText("Weekly recap").closest("li") as HTMLElement;
    expect(row).toHaveTextContent("Sundays 9:00 am · push");
    const options = within(row).getByRole("group", { name: "Weekly recap options" });
    await user.click(within(options).getByRole("radio", { name: "Email" }));
    await waitFor(() => expect(row).toHaveTextContent("Sundays 9:00 am · email"));
    expect(
      api.calls.find((c) => c.method === "PUT" && c.path === "/api/notifications/settings")?.body,
    ).toEqual({ prefs: { weekly_recap: { channel: "email" } } });
    await user.click(within(options).getByRole("radio", { name: "Both" }));
    await waitFor(() => expect(row).toHaveTextContent("Sundays 9:00 am · push and email"));
    expect(options).toHaveTextContent("The email has a link, never your numbers.");
  });

  it("registers the device's schedule as dates, types and keys only", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.balance_anchors.add({
      id: "a1",
      account_id: "acct-cash",
      as_of: "2026-10-05",
      balance_cents: 210000,
      source: "statement",
      created_at: "2026-10-05T00:00:00Z",
    });
    await db.recurring_series.add({
      id: "rent",
      payee: "RENT",
      label: "Rent",
      kind: "bill",
      expected_cents: 165000,
      interval: "monthly",
      next_date: "2026-10-25",
      status: "confirmed",
      source: "manual",
      account_id: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    const api = installFakeApi({ session: readySession() });
    renderApp("/insights");
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(
      () =>
        expect(api.calls.some((c) => c.method === "PUT" && c.path === "/api/alerts/schedule")).toBe(
          true,
        ),
      { timeout: 4000 },
    );
    const body = api.calls.find((c) => c.method === "PUT" && c.path === "/api/alerts/schedule")
      ?.body as { items: Array<Record<string, unknown>> };
    const rent = body.items.find((i) => i.dedupe_key === "upcoming:rent:2026-10-25");
    expect(rent).toBeDefined();
    expect(Object.keys(rent as object).sort()).toEqual(["dedupe_key", "due_at", "type"]);
    expect(rent?.type).toBe("upcoming_expense");
    expect(new Date(String(rent?.due_at)).toISOString()).toBe(
      new Date(2026, 9, 22, 9, 0).toISOString(),
    );
    expect(body.items.find((i) => i.dedupe_key === "recap:2026-10-11")).toBeDefined();
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/cents|Rent|merchant|1650/);
    expectNoAmountInKeys(body.items);
  });

  it("keys a shortfall by its date and a tag, never the amount", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.balance_anchors.add({
      id: "a1",
      account_id: "acct-cash",
      as_of: "2026-10-05",
      balance_cents: 210000,
      source: "statement",
      created_at: "2026-10-05T00:00:00Z",
    });
    await db.recurring_series.add({
      id: "rent",
      payee: "RENT",
      label: "Rent",
      kind: "bill",
      expected_cents: 345600,
      interval: "monthly",
      next_date: "2026-10-25",
      status: "confirmed",
      source: "manual",
      account_id: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    const api = installFakeApi({ session: readySession() });
    renderApp("/insights");
    await screen.findByRole("navigation", { name: "Primary" });
    const shortfallKeys = () =>
      (
        api.calls.filter((c) => c.method === "PUT" && c.path === "/api/alerts/schedule").at(-1)
          ?.body as { items: Array<Record<string, unknown>> } | undefined
      )?.items.filter((i) => i.type === "shortfall_risk") ?? [];
    await waitFor(() => expect(shortfallKeys().length).toBe(1), { timeout: 4000 });
    const key = String(shortfallKeys()[0]?.dedupe_key);
    expect(key).toMatch(/^shortfall:\d{4}-\d{2}-\d{2}$/);
    const body = api.calls
      .filter((c) => c.method === "PUT" && c.path === "/api/alerts/schedule")
      .at(-1)?.body as { items: Array<Record<string, unknown>> };
    expectNoAmountInKeys(body.items);
    expect(JSON.stringify(body)).not.toMatch(/3456|1356/);
  });

  it("a budget alert carries a month, a tag and a level: never the category or an amount (invariant 29)", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const row = (id: string, date: string, cents: number, category: string) => ({
      id,
      date,
      amount_cents: cents,
      direction: "out" as const,
      merchant: "Bistro Nine",
      clean_description: "BISTRO NINE",
      raw_description: null,
      category_id: category,
      account_id: "acct-cash",
      source: "manual" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: `${date}T10:00:00.000Z`,
      updated_at: `${date}T10:00:00.000Z`,
    });
    await db.entries.bulkAdd([
      row("d1", "2026-10-05", 18500, "cat-dining"), // 92.5% of 200.00: Close
      row("f1", "2026-10-06", 12000, "cat-fun"), // 120% of 100.00: Over
      row("s1", "2026-10-07", 60000, "cat-savings"), // the save bucket never alerts
    ]);
    await createBudget(db, "2026-10", "zero_based", 400000, [
      { category_id: "cat-dining", planned_cents: 20000 },
      { category_id: "cat-fun", planned_cents: 10000 },
      { category_id: "cat-savings", planned_cents: 50000 },
    ]);
    const api = installFakeApi({ session: readySession() });
    renderApp("/insights");
    await screen.findByRole("navigation", { name: "Primary" });
    const budgetItems = () =>
      (
        api.calls.filter((c) => c.method === "PUT" && c.path === "/api/alerts/schedule").at(-1)
          ?.body as { items: Array<Record<string, unknown>> } | undefined
      )?.items.filter((i) => i.type === "budget_pace") ?? [];
    await waitFor(() => expect(budgetItems()).toHaveLength(2), { timeout: 4000 });
    const items = budgetItems();
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["dedupe_key", "due_at", "type"]);
      // 09:00 has passed at noon: due now
      expect(new Date(String(item.due_at)).toISOString()).toBe(TODAY.toISOString());
    }
    const levels = items.map((i) => String(i.dedupe_key).split(":").at(-1)).sort();
    expect(levels).toEqual(["10000", "9000"]);
    for (const item of items)
      expect(String(item.dedupe_key)).toMatch(/^budget:2026-10:[a-p]{16}:(9000|10000)$/);
    const body = JSON.stringify(
      api.calls.filter((c) => c.method === "PUT" && c.path === "/api/alerts/schedule").at(-1)?.body,
    );
    expect(body).not.toMatch(/cat-|Dining|Fun|Savings|Bistro|BISTRO|18500|185\.00|20000|12000/);
    // The tag's salt is the device's own random value, kept in settings
    expect((await db.settings.get("alerts.tag_salt"))?.value).toMatch(/^[0-9a-f]{32}$/);
  });
});

/** Outside its ISO dates, no key carries a run of 3 or more digits (an amount, an account). A
 * budget alert's key is its own fixed shape: a month, a 16-letter tag and a level (invariant 29). */
function expectNoAmountInKeys(items: Array<Record<string, unknown>>): void {
  for (const item of items) {
    if (item.type === "budget_pace") {
      expect(String(item.dedupe_key)).toMatch(/^budget:\d{4}-\d{2}:[a-p]{16}:\d{4,5}$/);
      continue;
    }
    const key = String(item.dedupe_key).replace(/\d{4}-\d{2}-\d{2}/g, "");
    expect(key, String(item.dedupe_key)).not.toMatch(/\d{3,}/);
  }
}
