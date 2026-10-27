// @vitest-environment jsdom
/**
 * axe-core over every built page (docs/spec.md 1W: accessibility ≥ 90). jsdom has no layout,
 * so colour contrast is the token guard's job; names, roles, labels, landmarks and headings
 * must pass here.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import axe from "axe-core";

const dist = resolve(import.meta.dirname, "../dist");
const PAGES = [
  "index.html",
  "how-it-works.html",
  "pricing.html",
  "security.html",
  "privacy.html",
  "terms.html",
  "delete-account.html",
  "support.html",
  "licenses.html",
  "404.html",
];

describe.skipIf(!existsSync(dist))("the built site passes axe", () => {
  it.each(PAGES)("%s", async (name) => {
    const html = readFileSync(resolve(dist, name), "utf8");
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    document.documentElement.lang = html.match(/<html[^>]*\blang="([^"]+)"/)?.[1] ?? "";
    const results = await axe.run(document.documentElement, {
      rules: { "color-contrast": { enabled: false } },
    });
    const summary = results.violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(" ")).join("\n  ")}`,
    );
    expect(summary, summary.join("\n")).toEqual([]);
  });
});
