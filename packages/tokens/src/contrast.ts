/**
 * WCAG 2.x contrast math and the list of foreground/background pairs the tokens must satisfy.
 * Theme rule 5 (docs/spec.md): body text >= 4.5:1, large text >= 3:1, in all six look x mode
 * combinations. tools/check_contrast.ts runs this in CI.
 */

import { LOOKS, type Look, MODES, type Mode, tokens } from "./index";

export const AA_BODY = 4.5;
export const AA_LARGE = 3;

function channel(hex2: string): number {
  const v = Number.parseInt(hex2, 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of a #RRGGBB color (sRGB). */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`not a #RRGGBB color: ${hex}`);
  const h = m[1];
  return (
    0.2126 * channel(h.slice(0, 2)) +
    0.7152 * channel(h.slice(2, 4)) +
    0.0722 * channel(h.slice(4, 6))
  );
}

/** Contrast ratio between two colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  look: Look;
  mode: Mode;
  label: string;
  fg: string;
  bg: string;
  min: number;
}

/** Every text-on-surface pair a screen can produce from the tokens. */
export function contrastPairs(): ContrastPair[] {
  const pairs: ContrastPair[] = [];
  const s = tokens.semantic_proposed_verify_contrast;
  for (const look of LOOKS) {
    const l = tokens.looks[look];
    for (const mode of MODES) {
      const p = l[mode];
      const add = (label: string, fg: string, bg: string, min = AA_BODY) =>
        pairs.push({ look, mode, label, fg, bg, min });
      add("ink on bg", p.ink, p.bg);
      add("ink on card", p.ink, p.card);
      add("sub on bg", p.sub, p.bg);
      add("sub on card", p.sub, p.card);
      add("on-accent on a1 (hero card)", l.accent.on_accent, l.accent.a1);
      add("on-accent on a2", l.accent.on_accent, l.accent.a2);
      add("on-accent on a3", l.accent.on_accent, l.accent.a3);
      add("success on bg", s.success[mode], p.bg);
      add("success on card", s.success[mode], p.card);
      add("danger on bg", s.danger[mode], p.bg);
      add("danger on card", s.danger[mode], p.card);
      add("warning on bg", s.warning[mode], p.bg);
      add("warning on card", s.warning[mode], p.card);
      add("offline banner text", s.offline_banner.text, s.offline_banner[mode]);
      add(
        "pending chip text",
        mode === "light" ? s.pending_chip.light_text : s.pending_chip.dark_text,
        mode === "light" ? s.pending_chip.light_bg : s.pending_chip.dark_bg,
      );
    }
  }
  return pairs;
}
