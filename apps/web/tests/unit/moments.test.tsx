import moments from "@stackd/rules/moments";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Goal, openDb, seedDefaults } from "../../src/data/db.ts";
import { momentsLog } from "../../src/moments/bus.ts";
import {
  CATALOG,
  cardText,
  fill,
  type MomentType,
  nudgeCopy,
  pickIndex,
  pushSettingsTitle,
  toastText,
} from "../../src/moments/catalog.ts";
import { firstTimeFor } from "../../src/moments/MomentsHost.tsx";
import { getMomentPref } from "../../src/moments/prefs.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const IN_APP: MomentType[] = [
  "jar_deposit",
  "income_logged",
  "goal_reached",
  "milestone_reached",
  "debt_paid_down",
  "checkin_done",
  "spending_up",
  "over_plan",
];

function jar(over: Partial<Goal> = {}): Goal {
  return {
    id: "g-travel",
    kind: "save",
    title: "Travel",
    target_cents: 10000,
    target_days: null,
    label: null,
    category_id: null,
    start_date: "2026-10-01",
    end_date: null,
    baseline_cents: null,
    group_id: null,
    status: "active",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

async function signedIn(path: string) {
  installFakeApi({ session: readySession() });
  renderApp(path);
  await screen.findByRole("navigation", { name: "Primary" });
}

describe("the moments catalog (one file for every message)", () => {
  it("has words for every in-app event and every next move", () => {
    for (const type of IN_APP) {
      const ev = CATALOG.events[type];
      expect(ev?.toast ?? ev?.card, type).toBeTruthy();
      expect(ev?.effects, type).toBeTruthy();
    }
    for (const id of Object.keys(moments.nudges)) expect(nudgeCopy(id).title).not.toBe("");
    expect(pushSettingsTitle("weekly_recap")).toBe("Weekly recap");
  });

  it("fills placeholders and picks the same variant for the same seed", () => {
    expect(fill("{amount} into {jar}.", { amount: "$5.00", jar: "Travel" })).toBe(
      "$5.00 into Travel.",
    );
    expect(pickIndex("ev-1", 4)).toBe(pickIndex("ev-1", 4));
    const lines = new Set(
      ["a", "b", "c", "d", "e", "f"].map((s) =>
        toastText("jar_deposit", { amount: "$1.00", jar: "X" }, s),
      ),
    );
    expect(lines.size).toBeGreaterThan(1); // different deposits read differently
  });

  it("encouragement never scolds: no 'should', 'bad', 'too much' or 'stop'", () => {
    for (const type of ["spending_up", "over_plan"] as const) {
      const ev = CATALOG.events[type];
      for (const line of [...(ev?.toast ?? []), ...(ev?.card ?? [])])
        expect(line).not.toMatch(/\b(should|bad|too much|stop|must)\b/i);
    }
    expect(cardText("over_plan", { bucket: "Wants" }, "wants")).toMatch(/Wants|Plans bend/);
  });

  it("a once-per-month moment shows once per seed per month", async () => {
    const db = openDb("u1");
    const m = { type: "spending_up" as const, vars: { category: "Dining" }, seed: "cat-dining" };
    const oct = new Date("2026-10-12T12:00:00");
    expect(await firstTimeFor(db, m, oct)).toBe(true);
    expect(await firstTimeFor(db, m, oct)).toBe(false);
    expect(await firstTimeFor(db, { ...m, seed: "cat-groceries" }, oct)).toBe(true);
    expect(await firstTimeFor(db, m, new Date("2026-11-02T12:00:00"))).toBe(true);
  });
});

describe("moments in the app", () => {
  beforeEach(() => {
    momentsLog.length = 0;
  });

  it("a deposit says ka-ching in a toast; crossing the target is goal_reached", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.goals.add(jar());
    const user = userEvent.setup();
    await signedIn("/goals/g-travel");
    await user.type(await screen.findByLabelText("Other amount"), "40");
    await user.click(screen.getByRole("button", { name: "Log" }));
    await waitFor(() => expect(momentsLog.at(-1)?.type).toBe("jar_deposit"));
    expect(momentsLog.at(-1)?.vars).toEqual({ jar: "Travel", amount: "$40.00" });
    const toast = await screen.findByText(/\$40\.00/, { selector: ".moment-toast__text" });
    expect(toast.closest("[aria-live=polite]")).toBeTruthy();

    await waitFor(() => expect(screen.getByRole("img", { name: "40 percent" })).toBeTruthy());
    await user.type(screen.getByLabelText("Other amount"), "60");
    await user.click(screen.getByRole("button", { name: "Log" }));
    await waitFor(() => expect(momentsLog.at(-1)?.type).toBe("goal_reached"));
    await user.click(screen.getAllByRole("button", { name: "Dismiss" })[0] as HTMLElement);
  });

  it("logging money out does not celebrate", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const user = userEvent.setup();
    await signedIn("/add");
    await user.type(await screen.findByLabelText("Amount"), "12.50");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await db.entries.count()).toBe(1));
    expect(momentsLog.some((m) => m.type === "income_logged")).toBe(false);
  });

  it("logging money in celebrates", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    const user = userEvent.setup();
    await signedIn("/add");
    await user.click(await screen.findByRole("radio", { name: "Money in" }));
    await user.type(screen.getByLabelText("Amount"), "2400");
    const chips = screen.getByRole("group", { name: "Category" });
    await user.click(within(chips).getByRole("radio", { name: "Paycheck" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(momentsLog.at(-1)?.type).toBe("income_logged"));
    expect(momentsLog.at(-1)?.vars).toEqual({ amount: "$2,400.00" });
  });

  it("Sounds and Celebrations are switches under Display, on by default", async () => {
    const user = userEvent.setup();
    await signedIn("/me/look");
    const sounds = await screen.findByRole("switch", { name: /Sounds/ });
    const party = screen.getByRole("switch", { name: /Celebrations/ });
    expect(sounds).toBeChecked();
    expect(party).toBeChecked();
    expect(screen.getByRole("button", { name: "Play the ka-ching" })).toBeInTheDocument();
    await user.click(sounds);
    expect(screen.queryByRole("button", { name: "Play the ka-ching" })).toBeNull();
    expect(getMomentPref("sounds")).toBe(false);
    expect(getMomentPref("celebrations")).toBe(true);
  });
});
