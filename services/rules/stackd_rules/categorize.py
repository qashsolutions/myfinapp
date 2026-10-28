"""Categories for imported rows.

docs/spec.md "Statement import": categories come from a keyword table; a user correction can
become a rule ("Always put CORNER MKT in Groceries"). User rules win over the keyword table;
both match case-insensitively as a substring of the cleaned description, first match wins.
The keyword table is config (stackd_rules/config/keywords.yaml, compiled to keywords.json)
and is passed in, so this stays a pure function.

Nothing is guessed (owner decision, October 28, 2026: no AI in the code at all, so the bundled
learned model allowed on October 11 is gone): a description neither table matches stays
uncategorized for the person to sort.
"""

from __future__ import annotations

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
