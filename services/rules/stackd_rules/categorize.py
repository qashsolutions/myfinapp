"""Categories for imported rows.

docs/spec.md "Statement import": categories come from a keyword table; a user correction can
become a rule ("Always put CORNER MKT in Groceries"). User rules win over the keyword table;
both match case-insensitively as a substring of the cleaned description, first match wins.
The keyword table is config (stackd_rules/config/keywords.yaml, compiled to keywords.json)
and is passed in, so this stays a pure function.

`suggest` is the learned fallback (owner decision, October 11, 2026): a bundled linear model
over hashed character n-grams of the cleaned description, trained offline by
scripts/train_categorizer.py from the curated corpus and shipped as versioned integer weights
(config/categorize_corpus.yaml -> categorizer.json). It cannot make things up: the only
possible answers are the model's fixed category list or None, it never runs below its
confidence floors, inference is integer additions so both engines agree exactly, and the model
is passed in like the keyword table, so this stays a pure function. No network, no service.
"""

from __future__ import annotations

import re

from .errors import RuleError
from .fingerprint import clean_description

DIRECTIONS = ("in", "out")


def _rules(value: object, code: str) -> list[dict]:
    if not isinstance(value, list):
        raise RuleError(code)
    for rule in value:
        if (
            not isinstance(rule, dict)
            or not isinstance(rule.get("match"), str)
            or not rule["match"]
        ):
            raise RuleError(code)
    return value


def match(description: str, direction: str, user_rules: list[dict], keywords: dict) -> dict:
    """{"category_id", "matched_by" ("user" | "keyword" | None), "is_transfer_hint"}."""
    if direction not in DIRECTIONS:
        raise RuleError("invalid_direction")
    clean = clean_description(description)
    rules = _rules(user_rules, "invalid_rules")
    if not isinstance(keywords, dict):
        raise RuleError("invalid_keywords")
    transfer_words = keywords.get("transfer", [])
    table = _rules(keywords.get("keywords", []), "invalid_keywords")
    if not isinstance(transfer_words, list) or not all(isinstance(w, str) for w in transfer_words):
        raise RuleError("invalid_keywords")

    is_transfer_hint = any(clean_description(w) in clean for w in transfer_words)

    for rule in rules:
        if not isinstance(rule.get("category_id"), str):
            raise RuleError("invalid_rules")
        if clean_description(rule["match"]) in clean:
            return {
                "category_id": rule["category_id"],
                "matched_by": "user",
                "is_transfer_hint": is_transfer_hint,
            }
    for entry in table:
        wanted = entry.get("direction", "any")
        if wanted not in ("in", "out", "any"):
            raise RuleError("invalid_keywords")
        if wanted != "any" and wanted != direction:
            continue
        if clean_description(entry["match"]) in clean:
            category = entry.get("category_id")
            if not isinstance(category, str):
                raise RuleError("invalid_keywords")
            return {
                "category_id": category,
                "matched_by": "keyword",
                "is_transfer_hint": is_transfer_hint,
            }
    return {"category_id": None, "matched_by": None, "is_transfer_hint": is_transfer_hint}


FNV32_OFFSET = 0x811C9DC5
FNV32_PRIME = 0x01000193
_MASK32 = (1 << 32) - 1


def _fnv1a_32(data: bytes) -> int:
    h = FNV32_OFFSET
    for byte in data:
        h ^= byte
        h = (h * FNV32_PRIME) & _MASK32
    return h


_WORD = re.compile(r"[A-Z0-9]+")  # ASCII only, like every rules regex


def _word_buckets(clean: str, dim: int) -> list[int]:
    """Alphanumeric runs of three or more characters ("NETFLIX.COM" gives NETFLIX and COM),
    skipping pure numbers (store and phone fragments), hashed into their own bucket range
    [dim, 2*dim) so a word can never collide with a character n-gram."""
    out = set()
    for word in _WORD.findall(clean):
        if len(word) >= 3 and not word.isdigit():
            out.add(dim + _fnv1a_32(f"W:{word}".encode()) % dim)
    return sorted(out)


def _hashed_features(clean: str, ngrams: list, dim: int) -> list[int]:
    """Distinct buckets of the character n-grams of " <clean> " plus the word buckets.
    Presence, not counts."""
    padded = f" {clean} "
    out = set(_word_buckets(clean, dim))
    for n in ngrams:
        for i in range(len(padded) - n + 1):
            out.add(_fnv1a_32(padded[i : i + n].encode()) % dim)
    return sorted(out)


def _is_int(value: object) -> bool:
    """An int and not a bool: bool is an int subclass here, while the device reads true as no
    number at all."""
    return isinstance(value, int) and not isinstance(value, bool)


def _model(value: object) -> dict:
    if not isinstance(value, dict):
        raise RuleError("invalid_model")
    labels = value.get("labels")
    dim = value.get("dim")
    ngrams = value.get("ngrams")
    bias = value.get("bias")
    weights = value.get("weights")
    if (
        not isinstance(labels, list)
        or not labels
        or not all(isinstance(label, str) and label for label in labels)
        or not _is_int(dim)
        or dim <= 0
        or not isinstance(ngrams, list)
        or not ngrams
        or not all(_is_int(n) and n > 0 for n in ngrams)
        or not isinstance(bias, list)
        or len(bias) != len(labels)
        or not all(_is_int(b) for b in bias)
        or not isinstance(weights, dict)
        or not _is_int(value.get("min_score"))
        or not _is_int(value.get("min_margin"))
    ):
        raise RuleError("invalid_model")
    for row in weights.values():
        if not isinstance(row, list) or len(row) != len(labels):
            raise RuleError("invalid_model")
        if not all(_is_int(w) for w in row):
            raise RuleError("invalid_model")
    return value


def suggest(description: str, model: dict) -> dict:
    """The model's best category for a cleaned description, or None below its floors.

    {"category_id": str | None, "score": int, "margin": int}. Deterministic integer sums; a
    tied best score goes to the lower label index. Besides the score and margin floors, a
    suggestion needs positive word-level evidence: at least one whole word of the description
    must carry positive weight for the winning category, so a merchant the model never saw a
    word of is left Uncategorized instead of guessed from character overlap.
    """
    checked = _model(model)
    clean = clean_description(description)
    labels = checked["labels"]
    scores = list(checked["bias"])
    for bucket in _hashed_features(clean, checked["ngrams"], checked["dim"]):
        row = checked["weights"].get(str(bucket))
        if row is None:
            continue
        for i, weight in enumerate(row):
            scores[i] += weight
    best = max(range(len(labels)), key=lambda i: (scores[i], -i))
    second = max(scores[i] for i in range(len(labels)) if i != best) if len(labels) > 1 else 0
    margin = scores[best] - second
    word_evidence = False
    for bucket in _word_buckets(clean, checked["dim"]):
        row = checked["weights"].get(str(bucket))
        if row is not None and row[best] > 0:
            word_evidence = True
            break
    ok = word_evidence and scores[best] >= checked["min_score"] and margin >= checked["min_margin"]
    return {
        "category_id": labels[best] if ok else None,
        "score": scores[best],
        "margin": margin,
    }
