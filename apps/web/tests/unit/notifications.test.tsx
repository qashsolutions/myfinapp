import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
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
    expect(within(list).getAllByRole("listitem")).toHaveLength(7);
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
  });
});
