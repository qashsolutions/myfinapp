import { describe, expect, it } from "vitest";

import { handle } from "./engine.ts";
import { goldenRuleNames, loadGoldenCases, pythonRulesVersion } from "./golden.ts";
import { RULES } from "./registry.ts";
import { RULES_VERSION } from "./version.ts";

const cases = loadGoldenCases();

describe("golden fixtures (shared with services/rules)", () => {
  it("found fixtures", () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  for (const c of cases) {
    it(`${c.rule}/${c.name}`, () => {
      const response = handle({ id: 0, rule: c.rule, input: c.input });
      const actual = response.ok ? response.result : { error: response.error };
      expect(JSON.parse(JSON.stringify(actual))).toEqual(c.expected);
    });
  }
});

describe("parity with the Python package", () => {
  it("registers exactly the rules that have golden directories", () => {
    expect(Object.keys(RULES).sort()).toEqual(goldenRuleNames());
  });

  it("has the same RULES_VERSION", () => {
    expect(RULES_VERSION).toBe(pythonRulesVersion());
  });

  it("stamps rules_version on every response", () => {
    const first = cases[0];
    if (!first) throw new Error("no cases");
    expect(handle({ id: 7, rule: first.rule, input: first.input }).rules_version).toBe(
      RULES_VERSION,
    );
  });
});
