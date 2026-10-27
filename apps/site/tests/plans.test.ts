import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BANK_REFUND_FEE, FOUNDING, LIMITS, PLANS, REFUND_FEE } from "../src/data/plans.ts";

/** services/api/app/rules_server/plans.yaml is the source of truth; the site must not drift. */
const yaml = readFileSync(
  resolve(import.meta.dirname, "../../../services/api/app/rules_server/plans.yaml"),
  "utf8",
);

function block(plan: string): string {
  const start = yaml.indexOf(`\n  ${plan}:\n`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z]+:\n|\nfounding:/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function value(text: string, key: string): string | undefined {
  return text.match(new RegExp(`${key}: ([^\\n#]+)`))?.[1]?.trim();
}

const planByKey = Object.fromEntries(PLANS.map((p) => [p.key, p]));

describe("the site's prices and limits match plans.yaml", () => {
  it.each(["private", "connected"] as const)("%s", (key) => {
    const text = block(key);
    const price = value(text, "price_cents");
    expect(price).toBeDefined();
    const monthly = Number(price?.match(/monthly: (\d+)/)?.[1]);
    const yearly = Number(price?.match(/yearly: (\d+)/)?.[1]);
    expect([planByKey[key]?.monthlyCents, planByKey[key]?.yearlyCents]).toEqual([monthly, yearly]);
    const limit = (v: string | undefined) => (v === "null" ? null : Number(v));
    expect(LIMITS.goals_active_max[key]).toBe(Number(value(text, "goals_active_max")));
    expect(LIMITS.statement_accounts_max[key]).toBe(limit(value(text, "statement_accounts_max")));
    expect(LIMITS.groups_create[key]).toBe(value(text, "groups_create") === "true");
    expect(LIMITS.household[key]).toBe(value(text, "household") === "true");
    expect(LIMITS.backup[key]).toBe(value(text, "backup") === "true");
  });

  it("founding", () => {
    const text = yaml.slice(yaml.indexOf("\nfounding:"));
    expect(FOUNDING.oneTimeCents).toBe(Number(value(text, "one_time_cents")));
    expect(FOUNDING.years).toBe(Number(value(text, "term_years")));
    expect(FOUNDING.cap).toBe(Number(value(text, "cap")));
    expect(value(text, "grants")).toBe("connected");
  });

  it("the refund fee", () => {
    const text = yaml.slice(yaml.indexOf("\nrefunds:"));
    expect(REFUND_FEE.bps).toBe(Number(value(text, "fee_bps")));
    expect(REFUND_FEE.fixedCents).toBe(Number(value(text, "fee_fixed_cents")));
    expect(BANK_REFUND_FEE.bps).toBe(Number(value(text, "bank_fee_bps")));
    expect(BANK_REFUND_FEE.capCents).toBe(Number(value(text, "bank_fee_cap_cents")));
  });

  it("the trial lengths are the yaml's (no lasting Free plan)", () => {
    expect(PLANS.map((p) => p.key)).toEqual(["private", "connected"]);
    const trials = yaml.slice(yaml.indexOf("\ntrials:"));
    for (const p of PLANS)
      expect(trials).toMatch(new RegExp(`${p.key}: \\{ days: ${p.trialDays},`));
  });

  it("the plan cards say the limits the yaml sets", () => {
    const said = (key: string) =>
      (planByKey[key]?.features ?? []).map((f: { t: string }) => f.t).join(" · ");
    for (const key of ["private", "connected"] as const)
      expect(said(key)).toContain(`${LIMITS.goals_active_max[key]} jars & goals`);
    expect(said("private")).toContain("Unlimited statement accounts");
  });
});
