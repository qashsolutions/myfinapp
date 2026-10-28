/**
 * Port of stackd_rules/fingerprint.py: dedupe keys for imported rows.
 * FNV-1a 64 over "account|date|cents|clean", 16 hex chars. ASCII-only upper-casing so both
 * engines agree byte for byte.
 */

import { iso, parseDate } from "./dates.ts";
import { RuleError } from "./errors.ts";
import { assertInt } from "./money.ts";
import { collapseSpaces, trimSpaces } from "./text.ts";

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();

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
  const key = `${accountId}|${day}|${cents}|${cleanDescription(description)}`;
  return fnv1a64(encoder.encode(key)).toString(16).padStart(16, "0");
}
