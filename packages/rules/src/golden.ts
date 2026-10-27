/** Loads the shared fixtures from services/rules/tests/golden (test-only; Node APIs). */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { JsonObject } from "./registry.ts";

export const GOLDEN_DIR = fileURLToPath(
  new URL("../../../services/rules/tests/golden/", import.meta.url),
);
export const PYTHON_INIT = fileURLToPath(
  new URL("../../../services/rules/stackd_rules/__init__.py", import.meta.url),
);

export interface GoldenCase {
  rule: string;
  name: string;
  input: JsonObject;
  expected: JsonObject;
}

export function loadGoldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const rule of readdirSync(GOLDEN_DIR, { withFileTypes: true })) {
    if (!rule.isDirectory()) continue;
    const dir = `${GOLDEN_DIR}${rule.name}/`;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".input.json")) continue;
      const name = file.slice(0, -".input.json".length);
      cases.push({
        rule: rule.name,
        name,
        input: JSON.parse(readFileSync(`${dir}${file}`, "utf8")),
        expected: JSON.parse(readFileSync(`${dir}${name}.expected.json`, "utf8")),
      });
    }
  }
  return cases;
}

export function goldenRuleNames(): string[] {
  return readdirSync(GOLDEN_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function pythonRulesVersion(): string {
  const m = /RULES_VERSION = "([^"]+)"/.exec(readFileSync(PYTHON_INIT, "utf8"));
  if (!m?.[1]) throw new Error("RULES_VERSION not found in Python package");
  return m[1];
}
