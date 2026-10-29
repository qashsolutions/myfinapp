"""Categories for imported rows.

docs/spec.md "Statement import": categories come from a keyword table; a user correction can
become a rule ("Always put CORNER MKT in Groceries"). User rules win over the keyword table.
A rule or keyword matches as a **whole word** (`recurring.contains_word`: the characters just
before and after it, when there are any, are not A-Z or 0-9) in the cleaned description, or in
its merchant key (`fingerprint.merchant_key`, so "UBER *EATS" reads as UBER EATS and
"Netflix.com" as NETFLIX); the **longest** match wins, ties by order (October 29, 2026, invariant
50), so UBER EATS beats UBER and RENT never hits ENTERPRISE RENTALS or PARENT. The keyword table
is config (stackd_rules/config/keywords.yaml, compiled to keywords.json) and is passed in, so this
stays a pure function. Transfer words are still a plain substring of the cleaned description.

Nothing is guessed (owner decision, October 28, 2026: no AI in the code at all, so the bundled
learned model allowed on October 11 is gone): a description neither table matches stays
uncategorized for the person to sort.
"""

from __future__ import annotations

from .errors import RuleError
from .fingerprint import clean_description, merchant_key
from .recurring import contains_word

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


def _longest(clean: str, key: str, patterns: list[tuple[str, str]]) -> str | None:
    """The category of the longest pattern found as a whole word; ties go to the earlier one."""
    best: tuple[int, str] | None = None
    for pattern, category in patterns:
        p_clean = clean_description(pattern)
        hit = contains_word(clean, p_clean) or contains_word(key, merchant_key(pattern))
        if hit and (best is None or len(p_clean) > best[0]):
            best = (len(p_clean), category)
    return best[1] if best is not None else None


def match(description: str, direction: str, user_rules: list[dict], keywords: dict) -> dict:
    """{"category_id", "matched_by" ("user" | "keyword" | None), "is_transfer_hint"}."""
    if direction not in DIRECTIONS:
        raise RuleError("invalid_direction")
    clean = clean_description(description)
    key = merchant_key(description)
    rules = _rules(user_rules, "invalid_rules")
    if not isinstance(keywords, dict):
        raise RuleError("invalid_keywords")
    transfer_words = keywords.get("transfer", [])
    table = _rules(keywords.get("keywords", []), "invalid_keywords")
    if not isinstance(transfer_words, list) or not all(isinstance(w, str) for w in transfer_words):
        raise RuleError("invalid_keywords")
    for rule in rules:
        if not isinstance(rule.get("category_id"), str):
            raise RuleError("invalid_rules")
    wanted_table = []
    for entry in table:
        wanted = entry.get("direction", "any")
        if wanted not in ("in", "out", "any"):
            raise RuleError("invalid_keywords")
        if not isinstance(entry.get("category_id"), str):
            raise RuleError("invalid_keywords")
        if wanted == "any" or wanted == direction:
            wanted_table.append((entry["match"], entry["category_id"]))

    is_transfer_hint = any(clean_description(w) in clean for w in transfer_words)

    own = _longest(clean, key, [(r["match"], r["category_id"]) for r in rules])
    if own is not None:
        return {"category_id": own, "matched_by": "user", "is_transfer_hint": is_transfer_hint}
    found = _longest(clean, key, wanted_table)
    if found is not None:
        return {"category_id": found, "matched_by": "keyword", "is_transfer_hint": is_transfer_hint}
    return {"category_id": None, "matched_by": None, "is_transfer_hint": is_transfer_hint}
