/**
 * Invariant 56 (October 29, 2026): an ended challenge is over. The owner's test found one past
 * its last day still offered "Your target this month" to join, carried no Ended word, offered
 * "Log a deposit", and kept its jar in a place on the plan ("Using 2 of 10 … 1 is a challenge").
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb } from "../../src/data/db.ts";
import { createGoal } from "../../src/features/goals/useGoals.ts";
import { ENDED_MESSAGE } from "../../src/features/groups/JoinGroup.tsx";
import {
  fakeMember,
  freeBilling,
  installFakeApi,
  ME,
  mayasGroup,
  readySession,
} from "../fakeApi.ts";

const fakeConnected = () => ({ ...freeBilling(), plan: "connected" as const });

import { renderApp } from "../render.tsx";

const AFTER = new Date("2026-11-05T12:00:00"); // October's challenge ended on Oct 31

async function challengeJar() {
  return createGoal(openDb("u1"), {
    kind: "save",
    title: "October savings",
    target_cents: 25000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-10-01",
    end_date: "2026-10-31",
    baseline_cents: null,
    group_id: "g-maya",
  });
}

function joined() {
  const g = mayasGroup();
  return { ...g, ended: true, members: [...g.members, fakeMember(ME, "Nia", 4000)] };
}

describe("An ended challenge (invariant 56)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AFTER);
  });
  afterEach(() => vi.useRealTimers());

  it("shows Ended with the final board and nothing to log or invite to", async () => {
    await challengeJar();
    installFakeApi({ session: readySession(), groups: [joined()] });
    renderApp("/groups/g-maya");
    expect(await screen.findByRole("heading", { level: 1, name: "October savings" }));
    const mine = await screen.findByRole("region", { name: "Your progress" });
    expect(within(mine).getByText("Ended")).toBeInTheDocument();
    expect(mine).toHaveTextContent("ended Oct 31");
    expect(within(mine).queryByRole("link", { name: "Log a deposit" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Final leaderboard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
  });

  it("its jar takes no deposits and no longer holds a place on the plan", async () => {
    const jar = await challengeJar();
    installFakeApi({ session: readySession(), groups: [joined()], billing: fakeConnected() });
    renderApp(`/goals/${jar.id}`);
    expect(await screen.findByRole("region", { name: "Challenge ended" })).toHaveTextContent(
      "no longer uses a place",
    );
    expect(screen.queryByRole("region", { name: "Log money you set aside" })).toBeNull();
  });

  it("the Goals tab counts only running challenges and folds ended ones away", async () => {
    const user = userEvent.setup();
    await challengeJar();
    installFakeApi({ session: readySession(), groups: [joined()], billing: fakeConnected() });
    renderApp("/goals");
    const usage = await screen.findByText(/Using \d+ of 10 on your plan/);
    expect(usage).toHaveTextContent("Using 0 of 10 on your plan");
    expect(usage).not.toHaveTextContent("is a challenge");
    await user.click(screen.getByRole("radio", { name: "Challenges" }));
    const fold = await screen.findByText("Ended · 1");
    expect(fold.closest("details")).not.toHaveAttribute("open");
  });

  it("can't be joined: the preview says it ended and the server's 409 reads plainly", async () => {
    const user = userEvent.setup();
    const g = { ...mayasGroup(), ended: true };
    const api = installFakeApi({ session: readySession(), groups: [g] });
    renderApp("/groups/join?code=STK-4F9Q");
    expect(await screen.findByRole("alert")).toHaveTextContent(ENDED_MESSAGE);
    expect(screen.queryByText("Your target this month")).not.toBeInTheDocument();
    // An older server that still previews it: the device reads the end date itself.
    g.ended = false;
    await user.clear(screen.getByLabelText("Invite code"));
    await user.type(screen.getByLabelText("Invite code"), "4F9Q");
    const group = await screen.findByRole("region", { name: "Group" });
    await waitFor(() => expect(group).toHaveTextContent(ENDED_MESSAGE));
    expect(within(group).getByText("Ended")).toBeInTheDocument();
    expect(screen.queryByText("Your target this month")).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/api/groups/join")).toBe(false);
  });
});
