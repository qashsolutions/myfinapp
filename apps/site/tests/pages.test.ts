import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Runs against the built site (`pnpm build` first; turbo orders test after build). */
const dist = resolve(import.meta.dirname, "../dist");
const page = (name: string) => readFileSync(resolve(dist, name), "utf8");
const REQUIRED = [
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
  ".well-known/security.txt",
];

describe.skipIf(!existsSync(dist))("the built site", () => {
  it.each(REQUIRED)("ships %s", (name) => {
    expect(existsSync(resolve(dist, name))).toBe(true);
  });

  it("every page has a title, a description, one h1, a skip link and the legal footer", () => {
    for (const name of REQUIRED.filter((n) => n.endsWith(".html"))) {
      const html = page(name);
      expect(html, name).toMatch(/<title>[^<]+<\/title>/);
      expect(html, name).toMatch(/<meta name="description" content="[^"]+"/);
      expect(html.match(/<h1[\s>]/g)?.length, name).toBe(1);
      expect(html, name).toContain('href="#main"');
      expect(html, name).toContain("© 2026 Qash Solutions Inc.");
      expect(html, name).toContain('href="/privacy"');
      expect(html, name).toContain('href="/terms"');
      expect(html, name).toContain('href="/security"');
      expect(html, name).toContain('href="/support"');
    }
  });

  it("loads nothing from a third party: fonts and scripts are local", () => {
    for (const name of REQUIRED.filter((n) => n.endsWith(".html"))) {
      const html = page(name);
      // Loaded resources only (scripts, styles, fonts, images); outbound links are fine.
      const loaded = [
        ...html.matchAll(/<(?:script|img|iframe)[^>]+src="(https?:\/\/[^"]+)"/g),
        ...html.matchAll(/<link[^>]+href="(https?:\/\/[^"]+)"/g),
      ].map((m) => m[1]);
      for (const url of loaded)
        expect(url, `${name} loads ${url}`).toMatch(/^https:\/\/qash\.solutions\//);
    }
  });

  it("no page links to the app until it opens (PUBLIC_APP_LIVE) except its install page, and the delete page posts only to the API", () => {
    for (const name of REQUIRED.filter((n) => n.endsWith(".html"))) {
      expect(page(name), name).not.toMatch(/href="https:\/\/app\.qash\.solutions(?!\/install")/);
      // Every page offers the install page in its header (owner decision, October 19, 2026)
      expect(page(name), name).toContain('href="https://app.qash.solutions/install"');
    }
    expect(page("index.html")).toContain('<link rel="canonical" href="https://qash.solutions/">');
    expect(page("pricing.html")).toContain(
      '<link rel="canonical" href="https://qash.solutions/pricing">',
    );
    expect(page("delete-account.html")).toContain("/api/public/account/delete/send");
    expect(page("delete-account.html")).not.toMatch(/stripe|googleapis|analytics/i);
  });
});
