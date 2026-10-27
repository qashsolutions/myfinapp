import { describe, expect, it } from "vitest";
import type { Account, BalanceAnchor } from "../../src/data/db.ts";
import { pickAccount } from "../../src/features/forecast/useForecast.ts";

const account = (id: string, type: Account["type"]): Account => ({
  id,
  label: id,
  type,
  last4: null,
  institution: null,
  currency: "USD",
  created_at: "2026-09-01T00:00:00Z",
});
const anchor = (account_id: string, as_of: string): BalanceAnchor => ({
  id: `a-${account_id}-${as_of}`,
  account_id,
  as_of,
  balance_cents: 1000,
  source: "linked",
  created_at: "2026-10-13T23:08:37.433Z",
});

describe("forecast account", () => {
  const accounts = [
    account("sav", "savings"),
    account("cc", "credit_card"),
    account("chk", "checking"),
  ];

  it("prefers checking when a linked sync anchors every account on the same day", () => {
    const anchors = [
      anchor("sav", "2026-10-13"),
      anchor("cc", "2026-10-13"),
      anchor("chk", "2026-10-13"),
    ];
    expect(pickAccount(accounts, anchors, undefined)?.id).toBe("chk");
  });

  it("prefers an anchored checking account even when savings was anchored later, never a credit card", () => {
    // October 19, 2026: importing savings last must not move "safe to spend" onto savings
    expect(
      pickAccount(accounts, [anchor("chk", "2026-10-01"), anchor("sav", "2026-10-13")], undefined)
        ?.id,
    ).toBe("chk");
    expect(
      pickAccount(accounts, [anchor("sav", "2026-10-01"), anchor("cc", "2026-10-13")], undefined)
        ?.id,
    ).toBe("sav");
  });

  it("keeps the user's own choice", () => {
    expect(pickAccount(accounts, [anchor("chk", "2026-10-13")], "cc")?.id).toBe("cc");
  });
});
