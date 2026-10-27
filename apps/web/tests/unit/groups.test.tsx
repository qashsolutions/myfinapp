import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb } from "../../src/data/db.ts";
import {
  type FakeApi,
  fakeMember,
  installFakeApi,
  ME,
  mayasGroup,
  readySession,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

/** Nothing that leaves the device may carry an amount, a merchant or an account. */
function assertOnlyPercentagesLeft(api: FakeApi) {
  for (const call of api.calls) {
    const text = JSON.stringify(call.body ?? {});
    expect(text, `${call.method} ${call.path} ${text}`).not.toMatch(
      /cents|amount|merchant|account_id|balance/i,
    );
  }
}

describe("Groups", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a monthly savings challenge; only the name, month and a percentage leave the device", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/goals");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.click(screen.getByRole("radio", { name: "Challenges" }));
    expect(await screen.findByText(/No challenges yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Start a challenge" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Start a challenge" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Challenge name")).toHaveValue("October savings challenge");
    await user.click(screen.getByRole("radio", { name: "$500.00" }));
    await user.type(screen.getByLabelText("Your name, as members will see it"), "Nia");
    await user.click(screen.getByRole("button", { name: "Start challenge" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "October savings challenge" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Group · 1 person · ends Oct 31/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("$0.00 of $500.00")).toBeInTheDocument());
    expect(screen.getByText(/Nobody has logged a deposit yet/)).toBeInTheDocument();
    expect(screen.getByText(/Not on the board yet: you/)).toBeInTheDocument();

    const db = openDb("u1");
    const goals = await db.goals.toArray();
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      kind: "save",
      title: "October savings challenge",
      target_cents: 50000,
      group_id: "g1",
      start_date: "2026-10-01",
      end_date: "2026-10-31",
    });
    expect(api.calls.find((c) => c.method === "PATCH" && c.path === "/api/account")?.body).toEqual({
      display_name: "Nia",
    });
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/api/groups")?.body).toEqual({
      name: "October savings challenge",
      template_key: "monthly_savings",
      month: "2026-10",
      start_date: null,
    });

    // Log a deposit on the private goal: the server receives a percentage, nothing else
    await user.click(screen.getByRole("link", { name: "Log a deposit" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "October savings challenge" }),
    ).toBeInTheDocument();
    // Oct 10 -> Oct 31 = 21 days = 3 weeks -> $500 / 3 = $166.67 a week
    await user.click(await screen.findByRole("button", { name: "+$166.67" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "33 percent" })).toBeInTheDocument(),
    );
    await waitFor(() => {
      const put = api.calls.filter(
        (c) => c.method === "PUT" && c.path === "/api/groups/g1/progress",
      );
      expect(put.at(-1)?.body).toEqual({ progress_bps: 3333 });
    });
    assertOnlyPercentagesLeft(api);

    // Back on the challenge, I am on the board
    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(await screen.findByRole("radio", { name: "Challenges" }));
    const card = await screen.findByRole("link", { name: "October savings challenge" });
    expect(card).toHaveTextContent("33%");
    await user.click(card);
    await screen.findByRole("heading", { level: 1, name: "October savings challenge" });
    await waitFor(() => expect(screen.getByText("You: #1")).toBeInTheDocument());
    const board = screen.getByRole("list", { name: "Leaderboard" });
    expect(within(board).getAllByRole("listitem")).toHaveLength(1);
    expect(within(board).getByRole("listitem")).toHaveTextContent("You");
    expect(within(board).getByRole("listitem")).toHaveTextContent("33%");
    expect(await db.server_queue.count()).toBe(0);
  });

  it("joins by code from a share link: preview first, then the board ranked by percent", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession(), groups: [mayasGroup()] });
    renderApp("/groups/join?code=stk-4f9q");
    await screen.findByRole("navigation", { name: "Primary" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Join a group" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Invite code")).toHaveValue("STK-4F9Q");
    const group = await screen.findByRole("region", { name: "Group" });
    expect(group).toHaveTextContent("October savings");
    expect(group).toHaveTextContent("Started by Maya R. · Oct 1 – Oct 31");
    expect(group).toHaveTextContent("3 members");
    expect(screen.getByRole("region", { name: "What the group sees" })).toHaveTextContent(
      "Never your amounts",
    );

    await user.click(screen.getByRole("radio", { name: "$250.00" }));
    await user.type(screen.getByLabelText("Your name, as members will see it"), "Nia");
    await user.click(screen.getByRole("button", { name: 'Join as "Nia"' }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "October savings" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Group · 4 people · ends Oct 31/)).toBeInTheDocument();
    expect(screen.getByText("You: –")).toBeInTheDocument();
    const board = await screen.findByRole("list", { name: "Leaderboard" });
    await waitFor(() => expect(within(board).getAllByRole("listitem")).toHaveLength(3));
    const rows = within(board)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows[0]).toContain("1");
    expect(rows[0]).toContain("Maya R.");
    expect(rows[0]).toContain("86%");
    expect(rows[1]).toContain("Dev P.");
    expect(rows[2]).toContain("Sam K.");
    expect(screen.getByText(/Not on the board yet: you/)).toBeInTheDocument();
    // No dollar amounts for anyone else anywhere on the screen
    expect(board.textContent).not.toMatch(/\$/);
    expect(api.calls.find((c) => c.path === "/api/groups/join")?.body).toEqual({
      code: "STK-4F9Q",
    });
    assertOnlyPercentagesLeft(api);
    expect((await openDb("u1").goals.toArray())[0]).toMatchObject({
      group_id: "g-maya",
      target_cents: 25000,
    });
    expect(screen.getByRole("button", { name: "Leave group" })).toBeInTheDocument();
  });

  it("an unknown code says so", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/groups/join");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.type(await screen.findByLabelText("Invite code"), "zzzz");
    expect(await screen.findByRole("alert")).toHaveTextContent("No group with that code.");
  });

  it("the owner can remove a member and issue a new code", async () => {
    const user = userEvent.setup();
    const mine = {
      ...mayasGroup(),
      id: "g-mine",
      invite_code: "STK-MINE",
      owner_id: ME,
      members: [
        fakeMember(ME, "Nia", 2000, { is_owner: true }),
        fakeMember("u-dev", "Dev P.", 6400),
      ],
    };
    const api = installFakeApi({
      session: readySession({
        user: { id: ME, email: "nia@example.com", display_name: "Nia", look: "modern" },
      }),
      groups: [mine],
    });
    await openDb("u1").goals.add({
      id: "goal-mine",
      kind: "save",
      title: "October savings",
      target_cents: 50000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: "2026-10-31",
      baseline_cents: null,
      group_id: "g-mine",
      status: "active",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    });
    renderApp("/groups/g-mine");
    expect(
      await screen.findByRole("heading", { level: 1, name: "October savings" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Leave group" })).toBeNull();
    const board = await screen.findByRole("list", { name: "Leaderboard" });
    await waitFor(() => expect(within(board).getAllByRole("listitem")).toHaveLength(2));
    await user.click(within(board).getByRole("button", { name: "Remove" }));
    await user.click(within(board).getByRole("button", { name: "Really remove Dev P." }));
    await waitFor(() => expect(within(board).getAllByRole("listitem")).toHaveLength(1));
    expect(
      api.calls.some((c) => c.method === "DELETE" && c.path === "/api/groups/g-mine/members/u-dev"),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Invite" }));
    const sheet = await screen.findByRole("dialog", { name: "Invite friends" });
    expect(within(sheet).getByText("STK-MINE")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "New invite code" }));
    expect(await within(sheet).findByText("STK-NEW1")).toBeInTheDocument();
    assertOnlyPercentagesLeft(api);
  });
});

describe("More challenge types (fast-follow 4)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a No-Eat-Out Week is a seven-day habit: check in, and only the percentage leaves", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: readySession({
        user: { id: ME, email: "nia@example.com", display_name: "Nia", look: "modern" },
      }),
    });
    renderApp("/groups/new");
    await screen.findByRole("heading", { level: 1, name: "Start a challenge" });
    await user.click(screen.getByRole("radio", { name: "No-Eat-Out Week" }));
    expect(screen.getByLabelText("Challenge name")).toHaveValue("No-Eat-Out Week");
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-10-10");
    expect(screen.queryByText("Your target this month")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start challenge" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "No-Eat-Out Week" }),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/api/groups")?.body).toEqual({
      name: "No-Eat-Out Week",
      template_key: "no_eat_out_week",
      month: null,
      start_date: "2026-10-10",
    });
    const goal = (await openDb("u1").goals.toArray())[0];
    expect(goal).toMatchObject({
      kind: "habit",
      target_days: 7,
      label: "no eating out",
      group_id: "g1",
      start_date: "2026-10-10",
      end_date: "2026-10-16",
    });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Your progress" })).toHaveTextContent(
        "0 of 7 days",
      ),
    );

    await user.click(screen.getByRole("link", { name: "Check in for today" }));
    await user.click(await screen.findByRole("button", { name: "Check in for today" }));
    await screen.findByRole("button", { name: "Checked in today" });
    // One day of seven on the board: 1428 bps, no amounts anywhere
    await waitFor(() =>
      expect(
        api.calls.find((c) => c.method === "PUT" && c.path.endsWith("/progress"))?.body,
      ).toEqual({
        progress_bps: 1429,
      }),
    );
    assertOnlyPercentagesLeft(api);
  });

  it("a Dining diet joins with a usual spend and an amount to keep back", async () => {
    const user = userEvent.setup();
    const diet = {
      ...mayasGroup(),
      id: "g-diet",
      name: "Dining diet",
      template_key: "dining_diet",
      invite_code: "STK-D1ET",
    };
    const api = installFakeApi({
      session: readySession({
        user: { id: ME, email: "nia@example.com", display_name: "Nia", look: "modern" },
      }),
      groups: [diet],
    });
    renderApp("/groups/join?code=STK-D1ET");
    await screen.findByRole("region", { name: "Group" });
    expect(screen.getByRole("region", { name: "Group" })).toHaveTextContent("Dining diet");
    await user.type(screen.getByLabelText("What you usually spend on dining in a month"), "380");
    await user.click(screen.getByRole("radio", { name: "$100.00" }));
    await user.click(screen.getByRole("button", { name: 'Join as "Nia"' }));
    await screen.findByRole("heading", { level: 1, name: "Dining diet" });
    const goal = (await openDb("u1").goals.toArray())[0];
    expect(goal).toMatchObject({
      kind: "spend_less",
      category_id: "cat-dining",
      target_cents: 10000,
      baseline_cents: 38000,
      group_id: "g-diet",
    });
    expect(api.calls.find((c) => c.path === "/api/groups/join")?.body).toEqual({
      code: "STK-D1ET",
    });
    assertOnlyPercentagesLeft(api);
  });
});
