/**
 * Reach and Ahead on Net worth (owner decision, November 16, 2026): how reachable what you own
 * is, and net worth in 1, 3, 5 and 10 years with investments and retirement growing at the
 * person's own Later rates and everything else held. Expected values are worked by hand.
 */

import { screen, within } from "@testing-library/react";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { saveManual } from "../../src/features/networth/useNetWorth.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

async function own(items: Array<[string, string, number, ("asset" | "debt")?]>) {
  const db = openDb("u1");
  await seedDefaults(db);
  for (const [group, label, cents, kind] of items)
    await saveManual(db, { kind: kind ?? "asset", group, label, value_cents: cents });
}

beforeEach(() => {
  installFakeApi({ session: readySession() });
});

describe("Reach", () => {
  it("splits what you own by how soon it could be used", async () => {
    await own([
      ["savings", "Rainy day", 100000],
      ["investments", "Brokerage", 200000],
      ["retirement", "Rollover IRA", 500000],
      ["property", "Home", 1000000],
    ]);
    renderApp("/net-worth");
    const reach = await screen.findByRole("region", { name: "What you could reach" });
    // Cash $1,000 + investments $2,000
    expect(reach).toHaveTextContent("Ready$3,000.00 in cash and investments, within days");
    const rows = within(reach)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual([
      "CashReady now$1,000.00",
      "InvestmentsA few days to sell$2,000.00",
      "RetirementUsually tax and a penalty if taken early$5,000.00",
      "Home, car and otherNot spending money$10,000.00",
    ]);
  });

  it("says None when nothing is ready within days", async () => {
    await own([["retirement", "Rollover IRA", 500000]]);
    renderApp("/net-worth");
    const reach = await screen.findByRole("region", { name: "What you could reach" });
    expect(reach).toHaveTextContent("NoneNo cash or investments counted yet");
  });
});

describe("Ahead", () => {
  it("grows investments and retirement at the Later rates and holds the rest", async () => {
    // $100,000 in retirement, a $10,000 car, $4,000 owed on a card; rates 3 / 5 / 7%.
    await own([
      ["retirement", "401(k)", 10000000],
      ["vehicle", "Car", 1000000],
      ["card", "Visa", 400000, "debt"],
    ]);
    renderApp("/net-worth");
    const ahead = await screen.findByRole("region", { name: "Net worth ahead" });
    // 10 years at 5% compounded monthly: 100,000 × (1 + 0.05/12)^120 = 164,700.95;
    // + 10,000 car − 4,000 card = 170,700.95 → $170,700 in whole dollars.
    expect(await within(ahead).findByText("$170,700 in 10 years at 5%")).toBeInTheDocument();
    const rows = within(ahead)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    // 1 year: 100,000 × 1.05116190 = 105,116.19 → 111,116 middle;
    // 3% → 103,041.60 → 109,041; 7% → 107,229.01 → 113,229.
    expect(rows[0]).toBe("1 year$111,116$109,041 to $113,229");
    expect(rows).toHaveLength(4);
    expect(ahead).toHaveTextContent(
      "Investments and retirement grow at 3%, 5% or 7% a year, your rates in Later",
    );
    expect(ahead).toHaveTextContent("An illustration, not a prediction or advice.");
  });

  it("says how to start when nothing could grow", async () => {
    await own([["vehicle", "Car", 1000000]]);
    renderApp("/net-worth");
    const ahead = await screen.findByRole("region", { name: "Net worth ahead" });
    expect(ahead).toHaveTextContent(
      "StartAdd investments or retirement to see how they could grow.",
    );
  });

  it("shows a net worth below zero with its sign", async () => {
    await own([
      ["investments", "Brokerage", 100000],
      ["student_loan", "Student loan", 3000000, "debt"],
    ]);
    renderApp("/net-worth");
    const ahead = await screen.findByRole("region", { name: "Net worth ahead" });
    expect(await within(ahead).findByText(/^−\$28,3\d\d in 10 years at 5%$/)).toBeInTheDocument();
  });
});
