/**
 * Port of stackd_rules/fingerprint.py: dedupe keys for imported rows.
 * FNV-1a 64 over "account|date|cents|clean", 16 hex chars. ASCII-only upper-casing so both
 * engines agree byte for byte.
 */

import { iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt } from "./money.ts";
import { collapseSpaces, trimSpaces, utf8 } from "./text.ts";

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

export function cleanDescription(text: unknown): string {
  if (typeof text !== "string") throw new RuleError("invalid_description");
  return trimSpaces(collapseSpaces(text)).replace(/[a-z]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 32),
  );
}

export function fnv1a64(data: Uint8Array): bigint {
  let h = FNV64_OFFSET;
  for (const byte of data) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

export function fingerprint(
  accountId: unknown,
  date: unknown,
  amountCents: unknown,
  description: unknown,
): string {
  if (typeof accountId !== "string" || accountId === "") throw new RuleError("invalid_account");
  const day = iso(parseDate(date));
  const cents = assertInt(amountCents);
  utf8(accountId, "invalid_account");
  const clean = cleanDescription(description);
  utf8(clean, "invalid_description");
  const key = `${accountId}|${day}|${cents}|${clean}`;
  return fnv1a64(utf8(key, "invalid_description")).toString(16).padStart(16, "0");
}

// One merchant, one key (owner, October 29, 2026: "NETFLIX, netflix, Netflix.com: they are all
// the same"). The key never enters the fingerprint, so re-imports stay idempotent.
export const PROCESSOR_PREFIXES = ["SQ", "TST", "SP", "PAYPAL", "PP", "GOOGLE"];
const WEB_ENDINGS = [".COM", ".NET", ".ORG"];
const NUMBERED_WORDS = ["CHECK", "CHK", "CHEQUE"]; // the number names the item, so it is kept

/** Only ASCII digits and punctuation, or the masking dot: a store, terminal, phone or card
 * number. A letter A-Z or any other character (an accented letter, an emoji) keeps a word. */
function isNoise(token: string): boolean {
  for (const ch of token) {
    if (ch === "\u2022") continue;
    if (ch.charCodeAt(0) >= 0x80 || (ch >= "A" && ch <= "Z")) return false;
  }
  return true;
}

function firstWordHasDigit(text: string): boolean {
  return /[0-9]/.test(text.split(" ")[0] ?? "");
}

/**
 * Port of fingerprint.merchant_key: the merchant a bank text names, for matching only (never
 * shown, never in a fingerprint). A processor's prefix before "*" dropped, a reference after it
 * dropped, else the star is a space; "WWW." and one ".COM" / ".NET" / ".ORG" off each word; words
 * of only ASCII digits and punctuation or the masking dot dropped unless the first word is
 * CHECK, CHK or CHEQUE.
 */
export function merchantKey(text: unknown): string {
  const clean = cleanDescription(text);
  let work = clean;
  const star = work.indexOf("*");
  if (star !== -1) {
    const left = work.slice(0, star).replace(/^ +| +$/g, "");
    const right = work
      .slice(star + 1)
      .replace(/\*/g, " ")
      .split(" ")
      .filter((w) => w !== "")
      .join(" ");
    if (left === "") work = right;
    else if (right === "") work = left;
    else if (PROCESSOR_PREFIXES.includes(left)) work = right;
    else if (firstWordHasDigit(right)) work = left;
    else work = `${left} ${right}`;
  }
  const words: string[] = [];
  for (let token of work.split(" ")) {
    if (token.startsWith("WWW.")) token = token.slice(4);
    for (const ending of WEB_ENDINGS) {
      if (token.endsWith(ending)) {
        token = token.slice(0, -ending.length);
        break;
      }
    }
    if (token !== "") words.push(token);
  }
  const numbered = words.length > 0 && NUMBERED_WORDS.includes(words[0] as string);
  const kept = words.filter((w) => numbered || !isNoise(w));
  return kept.length > 0 ? kept.join(" ") : clean;
}
