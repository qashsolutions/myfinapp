import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { byLabel, compareText } from "../../src/lib/order.ts";

// Invariant 10, extended to the app (October 27, 2026): text is ordered one way everywhere and
// calendar days never go through Date.UTC (it reads years 0–99 as 1900–1999). localeCompare
// answers differently by the phone's language, so two devices could list the same data apart.
const ROOTS = ["apps/web/src", "packages/rules/src", "packages/ui/src", "apps/site/src"];
const FORBIDDEN = [/\.localeCompare\(/, /\bDate\.UTC\(/, /\bIntl\.Collator\b/];
const repo = join(import.meta.dirname, "../../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|astro)$/.test(name) ? [path] : [];
  });
}

describe("text and dates are handled one way", () => {
  it("no source orders text by locale or builds dates with Date.UTC", () => {
    const hits = ROOTS.flatMap((root) => sources(join(repo, root))).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
        .filter(({ line }) => FORBIDDEN.some((re) => re.test(line)))
        .map(({ i }) => `${relative(repo, file)}:${i + 1}`),
    );
    expect(hits).toEqual([]);
  });

  it("names people read sort A and a together, the same on every phone", () => {
    expect(["banana", "Apple", "apple", "Cherry", "_misc"].sort(byLabel)).toEqual([
      "_misc",
      "Apple",
      "apple",
      "banana",
      "Cherry",
    ]);
  });

  it("dates, timestamps and ids sort as the engine does", () => {
    expect(["2026-10-09", "2026-09-30", "2026-10-10"].sort(compareText)).toEqual([
      "2026-09-30",
      "2026-10-09",
      "2026-10-10",
    ]);
  });
});
