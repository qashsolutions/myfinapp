import { describe, expect, it } from "vitest";

import {
  allThemes,
  cssText,
  fontStack,
  LOOKS,
  MODES,
  NATIVE_LOOKS,
  themeVars,
  tokens,
  VARIABLE_NAMES,
} from "./index";

const HEX = /^#[0-9A-F]{6}$/i;

describe("tokens.json", () => {
  it("has every look and both palettes", () => {
    for (const look of LOOKS) {
      for (const mode of MODES) {
        const p = tokens.looks[look][mode];
        for (const v of Object.values(p)) expect(v).toMatch(HEX);
      }
      for (const v of Object.values(tokens.looks[look].accent)) expect(v).toMatch(HEX);
    }
  });

  it("ships all six looks on the web and three natively (owner decision, October 12, 2026)", () => {
    expect(tokens.availability.pwa).toEqual([...LOOKS]);
    expect(tokens.availability.native_ios_android).toEqual([...NATIVE_LOOKS]);
    for (const look of NATIVE_LOOKS) expect(LOOKS).toContain(look);
    expect(tokens.default.look).toBe("modern");
  });

  it("uses the Modern hero accent for the PWA manifest colors", () => {
    expect(tokens.pwa_manifest.theme_color).toBe(tokens.looks.modern.accent.a1);
    expect(tokens.pwa_manifest.background_color).toBe(tokens.looks.modern.accent.a1);
  });
});

describe("themeVars", () => {
  it("defines every variable for all six combinations", () => {
    const themes = allThemes();
    for (const look of LOOKS) {
      for (const mode of MODES) {
        const vars = themes[look][mode];
        for (const name of VARIABLE_NAMES)
          expect(vars[name], `${look}/${mode} ${name}`).toBeTruthy();
      }
    }
  });

  it("keeps accents and on-accent the same in light and dark", () => {
    for (const look of LOOKS) {
      const light = themeVars(look, "light");
      const dark = themeVars(look, "dark");
      expect(light["--c-a1"]).toBe(dark["--c-a1"]);
      expect(light["--c-on-accent"]).toBe(dark["--c-on-accent"]);
      expect(light["--c-bg"]).not.toBe(dark["--c-bg"]);
    }
  });

  it("locks semantic colors across looks", () => {
    for (const mode of MODES) {
      const [a, b, c] = LOOKS.map((look) => themeVars(look, mode));
      expect(a?.["--c-success"]).toBe(b?.["--c-success"]);
      expect(b?.["--c-danger"]).toBe(c?.["--c-danger"]);
    }
  });

  it("turns 'ink' in border and shadow into the ink variable", () => {
    const anime = themeVars("anime", "light");
    expect(anime["--border-card"]).toBe("3px solid var(--c-ink)");
    expect(anime["--shadow-card"]).toBe("0 5px 0 var(--c-ink)");
    expect(themeVars("modern", "light")["--border-card"]).toBe("none");
    expect(themeVars("pastel", "light")["--shadow-card"]).toBe("none");
  });

  it("maps toggle shapes to radii", () => {
    expect(themeVars("modern", "light")["--radius-toggle"]).toBe("999px");
    expect(themeVars("anime", "light")["--radius-toggle"]).toBe("8px");
  });

  it("strips usage notes from font specs", () => {
    expect(fontStack("Outfit (tabular)")).toBe('"Outfit", system-ui, sans-serif');
    expect(themeVars("anime", "dark")["--font-hero"]).toBe('"DotGothic16", system-ui, sans-serif');
    expect(themeVars("pastel", "light")["--font-body"]).toBe(
      '"Plus Jakarta Sans", system-ui, sans-serif',
    );
  });
});

describe("cssText", () => {
  const css = cssText();

  it("emits :root defaults plus one block per look x mode and a system-dark fallback", () => {
    expect(css).toContain(":root {");
    for (const look of LOOKS) {
      expect(css).toContain(`[data-look="${look}"], [data-look="${look}"][data-mode="light"] {`);
      expect(css).toContain(`[data-look="${look}"][data-mode="dark"] {`);
      expect(css).toContain(`[data-look="${look}"]:not([data-mode="light"]) {`);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });

  it("paints a look in light when the mode is system (no data-mode) and the OS is light", () => {
    const sel = `[data-look="illustrative"], [data-look="illustrative"][data-mode="light"] {`;
    const at = css.indexOf(sel);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(css.indexOf("@media (prefers-color-scheme: dark)"));
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain(`--c-bg: ${tokens.looks.illustrative.light.bg};`);
  });

  it("defaults :root to Modern light", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    expect(root).toContain(`--c-bg: ${tokens.looks.modern.light.bg};`);
    expect(root).toContain(`--c-a1: ${tokens.looks.modern.accent.a1};`);
  });
});
