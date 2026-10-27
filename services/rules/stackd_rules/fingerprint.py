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
from .text import collapse_spaces, trim_spaces

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
    key = f"{account_id}|{day.isoformat()}|{cents}|{clean_description(description)}"
    return f"{fnv1a_64(key.encode('utf-8')):016x}"
