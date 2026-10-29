"""Dedupe keys for imported rows.

docs/spec.md "Statement import": each row has a fingerprint (account, date, amount, cleaned
description) and duplicates are skipped, so re-uploading overlapping periods is safe.

The hash is FNV-1a 64 over "account|date|cents|clean". It is a dedupe key, not a secret,
and it is cheap to compute identically in Python and TypeScript. Cleaning touches ASCII
letters only, because Python's upper() and JavaScript's toUpperCase() disagree on some
Unicode letters and the two engines must agree byte for byte.
"""

from __future__ import annotations

from . import dates
from .errors import RuleError
from .money import _int
from .text import collapse_spaces, trim_spaces, utf8

_ASCII_LOWER = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
_MASK64 = 0xFFFFFFFFFFFFFFFF


def clean_description(text: str) -> str:
    """ "  Corner  Mkt #214 " -> "CORNER MKT #214": trimmed, single spaces, ASCII upper-case."""
    if not isinstance(text, str):
        raise RuleError("invalid_description")
    return trim_spaces(collapse_spaces(text)).translate(_ASCII_LOWER)


def fnv1a_64(data: bytes) -> int:
    h = FNV64_OFFSET
    for byte in data:
        h ^= byte
        h = (h * FNV64_PRIME) & _MASK64
    return h


def fingerprint(account_id: str, date: str, amount_cents: int, description: str) -> str:
    """16 hex chars identifying one statement row within an account."""
    if not isinstance(account_id, str) or not account_id:
        raise RuleError("invalid_account")
    day = dates.parse_date(date)
    cents = _int(amount_cents)
    utf8(account_id, "invalid_account")
    clean = clean_description(description)
    utf8(clean, "invalid_description")
    key = f"{account_id}|{day.isoformat()}|{cents}|{clean}"
    return f"{fnv1a_64(key.encode('utf-8')):016x}"


# One merchant, one key (owner, October 29, 2026: "NETFLIX, netflix, Netflix.com: they are all
# the same"). The key never enters the fingerprint, so re-imports stay idempotent.
PROCESSOR_PREFIXES = ("SQ", "TST", "SP", "PAYPAL", "PP", "GOOGLE")
WEB_ENDINGS = (".COM", ".NET", ".ORG")
NUMBERED_WORDS = ("CHECK", "CHK", "CHEQUE")  # the number names the item, so it is kept


def _is_noise(token: str) -> bool:
    """Only ASCII digits and punctuation, or the masking dot: a store, terminal, phone or card
    number. A letter A-Z or any other character (an accented letter, an emoji) keeps a word."""
    return all(ch == "\u2022" or (ch < "\x80" and not "A" <= ch <= "Z") for ch in token)


def _first_word_has_digit(text: str) -> bool:
    return any("0" <= ch <= "9" for ch in text.split(" ", 1)[0])


def merchant_key(text: str) -> str:
    """The merchant a bank text names, for matching only (never shown, never in a fingerprint).

    Cleaned like a fingerprint (ASCII upper-case, single spaces), then:
    1. At the first "*": a payment processor's prefix before it (SQ, TST, SP, PAYPAL, PP,
       GOOGLE) is dropped ("SQ *BLUE BOTTLE" -> "BLUE BOTTLE"); a reference after it, whose
       first word has a digit, is dropped ("AUDIBLE*2K4LP" -> "AUDIBLE"); otherwise the star is
       a space ("UBER *EATS" -> "UBER EATS"). Any later star is a space.
    2. In each word a leading "WWW." and then one trailing ".COM", ".NET" or ".ORG" are dropped.
    3. Words made only of ASCII digits and punctuation or the masking dot (store and terminal
       numbers, phone numbers, "#214", a masked "••1234") are dropped, except when the first
       word is CHECK, CHK or CHEQUE.
    Nothing left: the cleaned text itself.
    """
    clean = clean_description(text)
    work = clean
    if "*" in work:
        left, right = work.split("*", 1)
        left = left.strip(" ")
        right = " ".join(w for w in right.replace("*", " ").split(" ") if w)
        if not left:
            work = right
        elif not right:
            work = left
        elif left in PROCESSOR_PREFIXES:
            work = right
        elif _first_word_has_digit(right):
            work = left
        else:
            work = f"{left} {right}"
    words = []
    for token in work.split(" "):
        if token.startswith("WWW."):
            token = token[4:]
        for ending in WEB_ENDINGS:
            if token.endswith(ending):
                token = token[: -len(ending)]
                break
        if token:
            words.append(token)
    numbered = bool(words) and words[0] in NUMBERED_WORDS
    kept = [w for w in words if numbered or not _is_noise(w)]
    return " ".join(kept) if kept else clean
