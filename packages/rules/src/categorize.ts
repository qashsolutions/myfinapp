/**
 * Port of stackd_rules/categorize.py: user rules first, then the keyword table; substring
 * match on the cleaned description, first match wins. `suggest` is the learned fallback
 * (owner decision, October 11, 2026): the bundled integer model over hashed n-grams and
 * words, with a word-evidence gate so unknown merchants stay Uncategorized. No service, no
 * network; the model rides in as data like the keyword table.
 */

import { RuleError } from "./errors.ts";
import { cleanDescription } from "./fingerprint.ts";

export interface MatchResult {
  category_id: string | null;
  matched_by: "user" | "keyword" | null;
  is_transfer_hint: boolean;
}

interface RuleLike {
  match: string;
  category_id?: unknown;
  direction?: unknown;
}

function rules(value: unknown, code: string): RuleLike[] {
  if (!Array.isArray(value)) throw new RuleError(code);
  for (const rule of value) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      typeof (rule as RuleLike).match !== "string" ||
      (rule as RuleLike).match === ""
    ) {
      throw new RuleError(code);
    }
  }
  return value as RuleLike[];
}

export function match(
  description: unknown,
  direction: unknown,
  userRules: unknown,
  keywords: unknown,
): MatchResult {
  if (direction !== "in" && direction !== "out") throw new RuleError("invalid_direction");
  const clean = cleanDescription(description);
  const user = rules(userRules, "invalid_rules");
  if (typeof keywords !== "object" || keywords === null || Array.isArray(keywords)) {
    throw new RuleError("invalid_keywords");
  }
  const kw = keywords as { transfer?: unknown; keywords?: unknown };
  const transferWords = kw.transfer ?? [];
  const table = rules(kw.keywords ?? [], "invalid_keywords");
  if (!Array.isArray(transferWords) || !transferWords.every((w) => typeof w === "string")) {
    throw new RuleError("invalid_keywords");
  }
  const isTransferHint = transferWords.some((w) => clean.includes(cleanDescription(w)));

  for (const rule of user) {
    if (typeof rule.category_id !== "string") throw new RuleError("invalid_rules");
    if (clean.includes(cleanDescription(rule.match))) {
      return {
        category_id: rule.category_id,
        matched_by: "user",
        is_transfer_hint: isTransferHint,
      };
    }
  }
  for (const entry of table) {
    const wanted = entry.direction ?? "any";
    if (wanted !== "in" && wanted !== "out" && wanted !== "any")
      throw new RuleError("invalid_keywords");
    if (wanted !== "any" && wanted !== direction) continue;
    if (clean.includes(cleanDescription(entry.match))) {
      if (typeof entry.category_id !== "string") throw new RuleError("invalid_keywords");
      return {
        category_id: entry.category_id,
        matched_by: "keyword",
        is_transfer_hint: isTransferHint,
      };
    }
  }
  return { category_id: null, matched_by: null, is_transfer_hint: isTransferHint };
}

// --- the learned suggestion (chunk FF7) -------------------------------------------------------

const encoder = new TextEncoder();
const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;

export function fnv1a32(data: Uint8Array): number {
  let h = FNV32_OFFSET;
  for (const byte of data) {
    h = (h ^ byte) >>> 0;
    h = Math.imul(h, FNV32_PRIME) >>> 0;
  }
  return h >>> 0;
}

export interface SuggestModel {
  version: number;
  dim: number;
  ngrams: number[];
  labels: string[];
  bias: number[];
  weights: Record<string, number[]>;
  min_score: number;
  min_margin: number;
}

export interface SuggestResult {
  category_id: string | null;
  score: number;
  margin: number;
}

const WORD = /[A-Z0-9]+/g; // ASCII only, like every rules regex

function wordBuckets(clean: string, dim: number): number[] {
  const out = new Set<number>();
  for (const word of clean.match(WORD) ?? []) {
    if (word.length >= 3 && !/^[0-9]+$/.test(word)) {
      out.add(dim + (fnv1a32(encoder.encode(`W:${word}`)) % dim));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function hashedFeatures(clean: string, ngrams: number[], dim: number): number[] {
  const padded = ` ${clean} `;
  const out = new Set<number>(wordBuckets(clean, dim));
  for (const n of ngrams) {
    for (let i = 0; i + n <= padded.length; i++) {
      out.add(fnv1a32(encoder.encode(padded.slice(i, i + n))) % dim);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function isIntList(value: unknown, length: number | null): value is number[] {
  return (
    Array.isArray(value) &&
    (length === null || value.length === length) &&
    value.every((v) => Number.isInteger(v))
  );
}

function model(value: unknown): SuggestModel {
  if (typeof value !== "object" || value === null) throw new RuleError("invalid_model");
  const m = value as Partial<SuggestModel>;
  if (
    !Array.isArray(m.labels) ||
    m.labels.length === 0 ||
    !m.labels.every((label) => typeof label === "string" && label !== "") ||
    !Number.isInteger(m.dim) ||
    (m.dim as number) <= 0 ||
    !isIntList(m.ngrams, null) ||
    m.ngrams.length === 0 ||
    m.ngrams.some((n) => n <= 0) ||
    !isIntList(m.bias, m.labels.length) ||
    typeof m.weights !== "object" ||
    m.weights === null ||
    !Number.isInteger(m.min_score) ||
    !Number.isInteger(m.min_margin)
  ) {
    throw new RuleError("invalid_model");
  }
  for (const row of Object.values(m.weights)) {
    if (!isIntList(row, m.labels.length)) throw new RuleError("invalid_model");
  }
  return m as SuggestModel;
}

/**
 * The model's best category for a cleaned description, or null below its floors. Integer
 * sums only; ties go to the lower label index; a suggestion needs positive word-level
 * evidence for the winner, so a merchant the model never saw a word of stays Uncategorized.
 */
export function suggest(description: unknown, rawModel: unknown): SuggestResult {
  const checked = model(rawModel);
  const clean = cleanDescription(description);
  const scores = [...checked.bias];
  for (const bucket of hashedFeatures(clean, checked.ngrams, checked.dim)) {
    const row = checked.weights[String(bucket)];
    if (!row) continue;
    for (let i = 0; i < row.length; i++) scores[i] = (scores[i] as number) + (row[i] as number);
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++)
    if ((scores[i] as number) > (scores[best] as number)) best = i;
  let second = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < scores.length; i++)
    if (i !== best && (scores[i] as number) > second) second = scores[i] as number;
  const margin = scores.length > 1 ? (scores[best] as number) - second : (scores[best] as number);
  let wordEvidence = false;
  for (const bucket of wordBuckets(clean, checked.dim)) {
    const row = checked.weights[String(bucket)];
    if (row && (row[best] as number) > 0) {
      wordEvidence = true;
      break;
    }
  }
  const ok =
    wordEvidence && (scores[best] as number) >= checked.min_score && margin >= checked.min_margin;
  return {
    category_id: ok ? (checked.labels[best] as string) : null,
    score: scores[best] as number,
    margin,
  };
}
