import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { closeDb, deleteDb, openDb, seedDefaults } from "../../src/data/db.ts";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { addGoalEvent, createGoal } from "../../src/features/goals/useGoals.ts";
import { syncHousehold } from "../../src/features/household/householdSync.ts";
import {
  emptyHouseholds,
  type FakeHouseholds,
  freeBilling,
  installFakeApi,
  readySession,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const connected = () => ({ ...freeBilling(), plan: "connected" as const });
const maya = () =>
  readySession({
    user: { id: "u1", email: "maya@example.com", display_name: "Maya R.", look: "modern" },
  });
const dev = () =>
  readySession({
    user: { id: "u2", email: "dev@example.com", display_name: "Dev P.", look: "modern" },
  });

async function switchUser(id: string) {
  await new Promise((r) => setTimeout(r, 30)); // let the shell's live queries wind down first
  closeDb(id);
  await deleteDb(id);
  resetEntitlements();
}

describe("Couples & household", () => {
  afterEach(async () => {
    closeDb("u2");
    await deleteDb("u2");
  });

  it("needs Connected", async () => {
    installFakeApi({ session: maya(), billing: freeBilling() });
    renderApp("/me/household");
    expect(await screen.findByRole("status", { name: "Plan limit" })).toHaveTextContent(
      "Part of Connected",
    );
  });

  it("invite with a key in the link, the partner joins, a shared jar shows who added what, leaving splits it", async () => {
    const user = userEvent.setup();
    const households: FakeHouseholds = emptyHouseholds();

    // Maya (Connected) starts the household; the link carries the key after '#'
    const mayaApi = installFakeApi({ session: maya(), billing: connected(), households });
    let view = renderApp("/me/household");
    await user.click(await screen.findByRole("button", { name: "Make an invite link" }));
    const linkText = (await screen.findByText(/\/household\/join\?code=/)).textContent ?? "";
    const link = linkText.replace("Invite link: ", "").trim();
    const url = new URL(link, "http://localhost");
    const code = url.searchParams.get("code") ?? "";
    const key = url.hash.replace(/^#k=/, "");
    expect(code).toMatch(/^HH-/);
    expect(key.length).toBeGreaterThan(30);
    for (const c of mayaApi.calls) expect(JSON.stringify(c.body ?? {})).not.toContain(key);
    expect(screen.getByText(/Waiting for your partner/)).toBeInTheDocument();
    view.unmount();

    // Dev (Free, covered by Maya's plan) opens the link on their device
    await switchUser("u2");
    installFakeApi({ session: dev(), billing: freeBilling(), households });
    view = renderApp(`/household/join?code=${code}#k=${key}`);
    expect(await screen.findByText(/invited you to share a household/)).toHaveTextContent(
      "Maya R.",
    );
    await user.click(screen.getByRole("button", { name: "Join Maya R.'s household" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Couples & household" }),
    ).toBeInTheDocument();
    const members = await screen.findByRole("region", { name: "Household" });
    expect(members).toHaveTextContent("Maya R.");
    expect(members).toHaveTextContent("Dev P. (you)");
    expect(await openDb("u2").settings.get("household.key")).toMatchObject({ value: key });

    // Dev makes a shared jar and logs a deposit; it is published as ciphertext
    const devDb = openDb("u2");
    await seedDefaults(devDb);
    const jar = await createGoal(devDb, {
      kind: "save",
      title: "Trip",
      target_cents: 100000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: null,
      baseline_cents: null,
      group_id: null,
      household_id: households.rows[0]?.id ?? "",
    });
    await addGoalEvent(devDb, jar.id, "deposit", "2026-10-05", 20000, new Date(), "u2");
    await syncHousehold(devDb, "u2", "2026-10-10");
    const blob = households.rows[0]?.blobs.find((b) => b.kind === "jars");
    expect(blob?.author_id).toBe("u2");
    expect(blob?.ciphertext).not.toMatch(/Trip|20000|deposit/);
    view.unmount();

    // Back on Maya's device: the jar arrives with Dev's deposit; Maya adds her own
    await switchUser("u1");
    installFakeApi({ session: maya(), billing: connected(), households });
    const mayaDb = openDb("u1");
    await seedDefaults(mayaDb);
    await mayaDb.settings.put({
      key: "household.id",
      value: households.rows[0]?.id,
      updated_at: "x",
    });
    await mayaDb.settings.put({ key: "household.key", value: key, updated_at: "x" });
    await syncHousehold(mayaDb, "u1", "2026-10-10");
    expect(await mayaDb.goals.get(jar.id)).toMatchObject({
      title: "Trip",
      household_id: households.rows[0]?.id,
    });
    await addGoalEvent(mayaDb, jar.id, "deposit", "2026-10-06", 5000, new Date(), "u1");
    view = renderApp("/me/household");
    const shared = await screen.findByRole("article", { name: "Trip" });
    await waitFor(() => expect(shared).toHaveTextContent("You $50.00 · Dev P. $200.00"));
    expect(shared).toHaveTextContent("of $1,000.00");

    // The jar's screen names who deposited
    await user.click(within(shared).getByRole("button", { name: "Open" }));
    await screen.findByRole("heading", { level: 1, name: "Trip" });
    expect(screen.getByText("Shared")).toBeInTheDocument();
    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(recent).toHaveTextContent("Oct 6 · you");
    expect(recent).toHaveTextContent("Oct 5 · Dev P.");

    // Maya leaves: she keeps the jar with only her own deposit
    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(await screen.findByRole("link", { name: "Me" }));
    await user.click(await screen.findByRole("link", { name: /Groups & household/ }));
    await user.click(await screen.findByRole("link", { name: /Couples & household/ }));
    await user.click(await screen.findByRole("button", { name: "Leave household" }));
    const sheet = await screen.findByRole("dialog", { name: "Leave the household?" });
    await user.click(within(sheet).getByRole("button", { name: "Leave household" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/left the household/));
    const kept = await mayaDb.goal_events.where("goal_id").equals(jar.id).toArray();
    expect(kept.map((e) => [e.member_id, e.amount_cents])).toEqual([["u1", 5000]]);
    expect(await mayaDb.goals.get(jar.id)).toMatchObject({ household_id: null });
    expect(await mayaDb.settings.get("household.key")).toBeUndefined();
    expect(
      households.rows[0]?.members.filter((m) => m.left_at === null).map((m) => m.user_id),
    ).toEqual(["u2"]);
    view.unmount();
  });
});
