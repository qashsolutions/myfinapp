"""Integer-cents arithmetic with half-even rounding.

Every amount in Stackd is an int number of cents; percentages are basis points
(bps, 10000 = 100%). All rounding in the whole rules package funnels through
round_div so there is exactly one rounding rule.
"""

from __future__ import annotations

import re
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from fractions import Fraction

from .errors import RuleError
from .text import trim_spaces

_CENT = Decimal("0.01")
_UNSIGNED_DECIMAL = re.compile(r"[0-9]*\.?[0-9]*")  # ASCII only: \d would admit Unicode digits


def _int(value: object, code: str = "invalid_integer") -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuleError(code)
    return value


def parse_amount(text: str) -> int:
    """Statement or form text -> cents. "$1,234.56" -> 123456; "(45.00)" and "99.99-" are negative.

    Extra decimals round half-even ("1.005" -> 100, "1.015" -> 102). Anything else raises
    invalid_amount. Sign conventions beyond this (debit/credit columns) belong to the importer.
    """
    if not isinstance(text, str):
        raise RuleError("invalid_amount")
    s = trim_spaces(text).replace(",", "").replace("$", "")
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = trim_spaces(s[1:-1])
    if s.endswith("-"):
        negative = not negative
        s = trim_spaces(s[:-1])
    if s.startswith("-"):
        negative = not negative
        s = trim_spaces(s[1:])
    elif s.startswith("+"):
        s = trim_spaces(s[1:])
    if not s or s == "." or not _UNSIGNED_DECIMAL.fullmatch(s):
        raise RuleError("invalid_amount")
    try:
        value = Decimal(s)
    except InvalidOperation as exc:
        raise RuleError("invalid_amount") from exc
    cents = int(value.quantize(_CENT, rounding=ROUND_HALF_EVEN) * 100)
    return -cents if negative else cents


def round_div(numerator: int, denominator: int) -> int:
    """numerator / denominator rounded half to even. The only rounding in the package."""
    _int(numerator)
    if _int(denominator) == 0:
        raise RuleError("division_by_zero")
    return round(Fraction(numerator, denominator))


def pct_of(cents: int, bps: int) -> int:
    """bps/10000 of cents, half-even."""
    return round_div(_int(cents) * _int(bps), 10000)


def allocate(
    total_cents: int, weights_bps: list[int], remainder_to: int | None = None
) -> list[int]:
    """Split total_cents by weights that sum to 10000; the rounding remainder goes to one slot.

    50/30/20 is allocate(take_home, [5000, 3000, 2000], remainder_to=2): "remainder goes to save".
    remainder_to defaults to the last slot. The parts always sum to total_cents exactly.
    """
    total = _int(total_cents)
    if not isinstance(weights_bps, list) or not weights_bps:
        raise RuleError("weights_must_sum_to_10000")
    weights = [_int(w) for w in weights_bps]
    if sum(weights) != 10000:
        raise RuleError("weights_must_sum_to_10000")
    index = len(weights) - 1 if remainder_to is None else _int(remainder_to)
    if not 0 <= index < len(weights):
        raise RuleError("remainder_index_out_of_range")
    parts = [pct_of(total, w) for w in weights]
    parts[index] += total - sum(parts)
    return parts


def ratio_bps(part: int, whole: int) -> int | None:
    """part / whole in basis points, half-even. None when whole is 0 (callers hide the figure).

    Not capped: 150% is 15000. "Cap display at 100%, keep true value" is a display rule.
    """
    _int(part)
    if _int(whole) == 0:
        return None
    return round_div(part * 10000, whole)
