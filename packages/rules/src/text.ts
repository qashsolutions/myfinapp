/**
 * Text handled the same way in both engines (invariant 10; October 27, 2026).
 *
 * - `compareText` orders strings by Unicode code point, as Python's `<` and `sorted` do.
 *   `localeCompare` follows the device's language (so two phones could disagree) and `<` compares
 *   UTF-16 code units, which puts emoji before U+E000–U+FFFF; neither matches Python.
 * - `SPACE` is the one list of whitespace: JavaScript's `\s`, spelled out so it never depends on
 *   the engine's Unicode tables. Python's `\s` and `strip()` differ (they include U+001C–U+001F
 *   and U+0085, and leave U+FEFF), so stackd_rules/text.py uses this same list.
 */

import { RuleError } from "./errors.ts";

export const SPACE_CLASS =
  "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
const RUNS = new RegExp(`${SPACE_CLASS}+`, "g");
const EDGES = new RegExp(`^${SPACE_CLASS}+|${SPACE_CLASS}+$`, "g");

/** Every run of whitespace becomes one space. */
const encoder = new TextEncoder();

/**
 * UTF-8 bytes of text, or RuleError(code) when it holds a lone surrogate: TextEncoder would
 * quietly write U+FFFD where Python cannot encode at all, so both engines refuse it.
 */
export function utf8(text: string, code: string): Uint8Array {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      throw new RuleError(code);
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new RuleError(code);
  }
  return encoder.encode(text);
}

export function collapseSpaces(text: string): string {
  return text.replace(RUNS, " ");
}

/** Whitespace removed from both ends. */
export function trimSpaces(text: string): string {
  return text.replace(EDGES, "");
}

/** Code-point order: negative, zero or positive, as Python compares str. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length < 0 ? -1 : a.length === b.length ? 0 : 1;
}
