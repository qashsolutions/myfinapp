/**
 * Every golden pair from services/rules, run through the device's own engine door
 * (`engine/bridge.ts`, the inline transport jsdom falls back to), so the numbers the app shows
 * are the numbers the Python source of truth produces. packages/rules runs the same files
 * against the port directly; this run proves the wiring in between adds nothing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RULES_VERSION } from "@stackd/rules";
import { EngineError, engine } from "../../src/engine/bridge.ts";

const GOLDEN = resolve(import.meta.dirname, "../../../../services/rules/tests/golden");
const rules = readdirSync(GOLDEN, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const cases = rules.flatMap((rule) =>
  readdirSync(resolve(GOLDEN, rule))
    .filter((f) => f.endsWith(".input.json"))
    .map((f) => [rule, f.replace(/\.input\.json$/, "")] as const),
);

describe("the device engine reproduces every golden case", () => {
  it("stamps the shared rules version", async () => {
    await engine.call("money.parse_amount", { text: "1" }); // the stamp arrives with the first answer
    expect(engine.rulesVersion).toBe(RULES_VERSION);
    expect(cases.length).toBeGreaterThan(300);
  });

  it.each(cases)("%s / %s", async (rule, name) => {
    const input = JSON.parse(readFileSync(resolve(GOLDEN, rule, `${name}.input.json`), "utf8"));
    const expected = JSON.parse(
      readFileSync(resolve(GOLDEN, rule, `${name}.expected.json`), "utf8"),
    );
    if (expected && typeof expected === "object" && "error" in expected) {
      await expect(engine.call(rule, input)).rejects.toSatisfy(
        (e: unknown) => e instanceof EngineError && e.code === expected.error,
      );
    } else {
      expect(await engine.call(rule, input)).toEqual(expected);
    }
  });
});
