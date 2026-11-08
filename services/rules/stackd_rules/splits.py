"""Split bills (docs/spec.md "Split bills", "Calculation rules").

share          one bill's parts: equal, percent (bps summing to 10000) or shares (whole
               numbers > 0) give each person ⌊amount × weight ÷ Σ weights⌋ whole cents and the
               leftover cents to `leftover_to`; exact takes the cents given, which must add up.
balances       per person: paid − own parts, + settlements sent − settlements received; a
               disputed bill is on hold for everyone. Always sums to 0.
simplify       the largest debtor pays the largest creditor the smaller amount, ties by person in
               code-point order, until everyone is at 0 (at most people − 1 payments).
repeat_dates   a repeating bill's due dates from its start through as_of; monthly and yearly
               return to the start's day of the month (clamped), like forecast.upcoming.
"""

from __future__ import annotations

from . import dates, recurring
from .errors import RuleError
from .money import _int

METHODS = ("equal", "exact", "percent", "shares")
REPEATS = ("weekly", "monthly", "yearly")
MAX_REPEAT_DATES = 400


def _people(people: object) -> list[str]:
    if not isinstance(people, list) or not people:
        raise RuleError("no_people")
    ids: list[str] = []
    for p in people:
        if not isinstance(p, str) or not p or p in ids:
            raise RuleError("invalid_people")
        ids.append(p)
    return ids


def _values(values: object, ids: list[str]) -> dict[str, int]:
    if not isinstance(values, dict) or set(values) != set(ids):
        raise RuleError("values_must_match_people")
    out = {p: _int(values[p], "invalid_share") for p in ids}
    if any(v < 0 for v in out.values()):
        raise RuleError("invalid_share")
    return out


def share(
    amount_cents: object, method: object, people: object, leftover_to: object, values: object = None
) -> dict:
    amount = _int(amount_cents, "invalid_amount")
    if amount <= 0:
        raise RuleError("invalid_amount")
    if method not in METHODS:
        raise RuleError("invalid_method")
    ids = _people(people)
    if leftover_to not in ids:
        raise RuleError("leftover_to_not_in_split")
    if method == "equal":
        if values is not None:
            raise RuleError("values_not_used")
        weights = dict.fromkeys(ids, 1)
    else:
        weights = _values(values, ids)
    if method == "exact":
        if sum(weights.values()) != amount:
            raise RuleError("parts_do_not_add_up")
        parts = dict(weights)
    else:
        if method == "percent" and sum(weights.values()) != 10000:
            raise RuleError("percent_must_sum_to_10000")
        if method == "shares" and any(w == 0 for w in weights.values()):
            raise RuleError("invalid_share")
        total_weight = sum(weights.values())
        parts = {p: amount * weights[p] // total_weight for p in ids}
        parts[leftover_to] += amount - sum(parts.values())
    return {
        "parts": [{"person": p, "cents": parts[p]} for p in ids],
        "total_cents": amount,
    }


def balances(people: object, bills: object, settlements: object) -> dict:
    ids = _people(people)
    totals = dict.fromkeys(ids, 0)
    if not isinstance(bills, list):
        raise RuleError("invalid_bills")
    seen: set[str] = set()
    on_hold: list[str] = []
    for b in bills:
        if not isinstance(b, dict) or not isinstance(b.get("id"), str) or not b["id"]:
            raise RuleError("invalid_bill")
        if b["id"] in seen:
            raise RuleError("duplicate_bill")
        seen.add(b["id"])
        amount = _int(b.get("amount_cents"), "invalid_amount")
        if amount <= 0:
            raise RuleError("invalid_amount")
        payer = b.get("paid_by")
        parts = b.get("parts")
        if payer not in totals:
            raise RuleError("unknown_person")
        if not isinstance(parts, list) or not parts:
            raise RuleError("invalid_bill")
        owed: list[tuple[str, int]] = []
        for part in parts:
            if not isinstance(part, dict):
                raise RuleError("invalid_bill")
            if part.get("person") not in totals:
                raise RuleError("unknown_person")
            cents = _int(part.get("cents"), "invalid_amount")
            if cents < 0:
                raise RuleError("invalid_amount")
            owed.append((part["person"], cents))
        if sum(c for _, c in owed) != amount:
            raise RuleError("parts_do_not_add_up")
        if not isinstance(b.get("disputed"), bool):
            raise RuleError("invalid_bill")
        if b["disputed"]:
            on_hold.append(b["id"])
            continue
        totals[payer] += amount
        for person, cents in owed:
            totals[person] -= cents
    if not isinstance(settlements, list):
        raise RuleError("invalid_settlements")
    for s in settlements:
        if not isinstance(s, dict):
            raise RuleError("invalid_settlement")
        sender, receiver = s.get("from"), s.get("to")
        if sender not in totals or receiver not in totals:
            raise RuleError("unknown_person")
        if sender == receiver:
            raise RuleError("invalid_settlement")
        cents = _int(s.get("cents"), "invalid_amount")
        if cents <= 0:
            raise RuleError("invalid_amount")
        totals[sender] += cents
        totals[receiver] -= cents
    return {
        "balances": [{"person": p, "cents": totals[p]} for p in ids],
        "on_hold": on_hold,
    }


def _largest(side: dict[str, int]) -> str:
    # Largest amount first, then the person id in code-point order (Python's str order).
    return min(side, key=lambda p: (-side[p], p))


def simplify(balances: object) -> dict:
    if not isinstance(balances, list):
        raise RuleError("invalid_balances")
    owe: dict[str, int] = {}
    owed: dict[str, int] = {}
    seen: set[str] = set()
    total = 0
    for b in balances:
        if not isinstance(b, dict) or not isinstance(b.get("person"), str) or not b["person"]:
            raise RuleError("invalid_people")
        person = b["person"]
        if person in seen:
            raise RuleError("invalid_people")
        seen.add(person)
        cents = _int(b.get("cents"), "invalid_amount")
        total += cents
        if cents < 0:
            owe[person] = -cents
        elif cents > 0:
            owed[person] = cents
    if total != 0:
        raise RuleError("balances_do_not_sum_to_zero")
    payments: list[dict] = []
    while owe:
        debtor, creditor = _largest(owe), _largest(owed)
        cents = min(owe[debtor], owed[creditor])
        payments.append({"from": debtor, "to": creditor, "cents": cents})
        for side, person in ((owe, debtor), (owed, creditor)):
            side[person] -= cents
            if side[person] == 0:
                del side[person]
    return {"payments": payments}


def repeat_dates(start: object, every: object, as_of: object) -> dict:
    first = dates.parse_date(start)
    last = dates.parse_date(as_of)
    if every not in REPEATS:
        raise RuleError("invalid_interval")
    out: list[str] = []
    day = first
    while day <= last:
        if len(out) == MAX_REPEAT_DATES:
            raise RuleError("too_many_dates")
        out.append(day.isoformat())
        day = recurring.step_keeping_day(day, every, first.day)
    return {"dates": out}
