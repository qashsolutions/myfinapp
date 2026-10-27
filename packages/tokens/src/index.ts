/**
 * Design tokens, straight from tokens.json (copied verbatim from docs/design-handoff).
 *
 * Six looks x two modes, one token set (three in the native apps). Components read CSS custom properties only;
 * there are no per-look component forks (docs/spec.md, "Theme rules"). The app sets
 * data-look and data-mode on <html>; "system" or no data-mode follows prefers-color-scheme.
 */

import raw from "../tokens.json";

export const LOOKS = ["modern", "minimal", "retro", "pastel", "anime", "illustrative"] as const;
/** The looks the native apps offer (owner decision, October 12, 2026); the PWA offers all. */
export const NATIVE_LOOKS = ["modern", "pastel", "anime"] as const;
export const MODES = ["light", "dark"] as const;
export type Look = (typeof LOOKS)[number];
export type Mode = (typeof MODES)[number];

export interface Palette {
  bg: string;
  card: string;
  ink: string;
  sub: string;
  line: string;
}

export interface Accent {
  a1: string;
  a2: string;
  a3: string;
  on_accent: string;
}

export interface Fonts {
  display: string;
  body: string;
  hero_number: string;
  data_number: string;
}

export interface LookTokens {
  fonts: Fonts;
  radius_px: number;
  border: string;
  shadow: string;
  toggle: string;
  decoration?: string[];
  accent: Accent;
  light: Palette;
  dark: Palette;
}

export interface ModePair {
  light: string;
  dark: string;
}

export interface Semantic {
  success: ModePair;
  danger: ModePair;
  warning: ModePair;
  offline_banner: ModePair & { text: string };
  pending_chip: { light_bg: string; light_text: string; dark_bg: string; dark_text: string };
}

export interface Tokens {
  availability: { pwa: Look[]; native_ios_android: Look[] };
  default: { look: Look; mode: Mode | "system"; simple_layout: boolean };
  rules: Record<string, string>;
  looks: Record<Look, LookTokens>;
  semantic_proposed_verify_contrast: Semantic;
  pwa_manifest: {
    theme_color: string;
    background_color: string;
    display: string;
    icons: string[];
  };
  plans: Record<string, Record<string, unknown>>;
}

export const tokens = raw as unknown as Tokens;

/** CSS custom property names every theme defines, in output order. */
export const VARIABLE_NAMES = [
  "--c-bg",
  "--c-card",
  "--c-ink",
  "--c-sub",
  "--c-line",
  "--c-a1",
  "--c-a2",
  "--c-a3",
  "--c-on-accent",
  "--c-success",
  "--c-danger",
  "--c-warning",
  "--c-offline-bg",
  "--c-offline-text",
  "--c-pending-bg",
  "--c-pending-text",
  "--radius-card",
  "--border-card",
  "--shadow-card",
  "--radius-toggle",
  "--font-display",
  "--font-body",
  "--font-hero",
  "--font-data",
  "--numeric-data",
] as const;

export type VariableName = (typeof VARIABLE_NAMES)[number];
export type ThemeVars = Record<VariableName, string>;

const FONT_FALLBACK = ", system-ui, sans-serif";
const TOGGLE_RADIUS: Record<string, string> = { pill: "999px", "rounded-square-8px": "8px" };

/** "Outfit (tabular)" -> '"Outfit", system-ui, sans-serif'. Parentheticals are usage notes. */
export function fontStack(spec: string): string {
  const family = spec.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return `"${family}"${FONT_FALLBACK}`;
}

/** tokens.json writes "3px solid ink" or "1px solid line"; CSS needs the variable. */
function inkRef(value: string): string {
  return value.replace(/\bink\b/g, "var(--c-ink)").replace(/\bline\b/g, "var(--c-line)");
}

export function themeVars(look: Look, mode: Mode): ThemeVars {
  const l = tokens.looks[look];
  const p = l[mode];
  const s = tokens.semantic_proposed_verify_contrast;
  return {
    "--c-bg": p.bg,
    "--c-card": p.card,
    "--c-ink": p.ink,
    "--c-sub": p.sub,
    "--c-line": p.line,
    "--c-a1": l.accent.a1,
    "--c-a2": l.accent.a2,
    "--c-a3": l.accent.a3,
    "--c-on-accent": l.accent.on_accent,
    "--c-success": s.success[mode],
    "--c-danger": s.danger[mode],
    "--c-warning": s.warning[mode],
    "--c-offline-bg": s.offline_banner[mode],
    "--c-offline-text": s.offline_banner.text,
    "--c-pending-bg": mode === "light" ? s.pending_chip.light_bg : s.pending_chip.dark_bg,
    "--c-pending-text": mode === "light" ? s.pending_chip.light_text : s.pending_chip.dark_text,
    "--radius-card": `${l.radius_px}px`,
    "--border-card": inkRef(l.border),
    "--shadow-card": inkRef(l.shadow),
    "--radius-toggle": TOGGLE_RADIUS[l.toggle] ?? "999px",
    "--font-display": fontStack(l.fonts.display),
    "--font-body": fontStack(l.fonts.body),
    "--font-hero": fontStack(l.fonts.hero_number),
    "--font-data": fontStack(l.fonts.data_number),
    "--numeric-data": "tabular-nums",
  };
}

export type Themes = Record<Look, Record<Mode, ThemeVars>>;

export function allThemes(): Themes {
  const out = {} as Themes;
  for (const look of LOOKS) {
    out[look] = { light: themeVars(look, "light"), dark: themeVars(look, "dark") };
  }
  return out;
}

function block(selector: string, vars: ThemeVars): string {
  const lines = VARIABLE_NAMES.map((name) => `  ${name}: ${vars[name]};`);
  return `${selector} {\n${lines.join("\n")}\n}`;
}

/**
 * The whole stylesheet. :root carries the default (Modern light) so a page is never
 * unstyled; explicit data-mode wins; "system" (no data-mode) is light unless the OS is dark.
 */
export function cssText(): string {
  const parts = [
    "/* Generated from packages/tokens/tokens.json by src/build.ts. Do not edit by hand. */",
    block(":root", themeVars(tokens.default.look, "light")),
  ];
  for (const look of LOOKS) {
    // No data-mode ("system") gets light here and dark from the media block below.
    parts.push(
      block(
        `[data-look="${look}"], [data-look="${look}"][data-mode="light"]`,
        themeVars(look, "light"),
      ),
      block(`[data-look="${look}"][data-mode="dark"]`, themeVars(look, "dark")),
    );
  }
  const system = LOOKS.map((look) =>
    block(`[data-look="${look}"]:not([data-mode="light"])`, themeVars(look, "dark")),
  );
  parts.push(`@media (prefers-color-scheme: dark) {\n${system.join("\n")}\n}`);
  return `${parts.join("\n\n")}\n`;
}
