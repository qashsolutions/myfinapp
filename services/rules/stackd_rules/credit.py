"""Credit cards from linked card details (chunk 3.5; docs/spec.md "Calculation rules": Card
utilisation, Pay in full by the due date). Read-only facts and a plan; nothing moves money.

utilization_bps   statement balance (else current) ÷ limit in bps, half-even; null without a
                  limit; a credit balance counts as 0; may pass 10000.
pay_in_full       what is left of the statement balance after a payment made since the
                  statement, split across the paydays from as_of through the due date (the
                  first ones carry the odd cents), else one payment on the due date.
"""

from __future__ import annotations

from .dates import days_until, parse_date
from .errors import RuleError
from .money import _int, ratio_bps


def _opt_int(value: object) -> int | None:
    return None if value is None else _int(value)


def _opt_date(value: object):
    return None if value is None else parse_date(value)


def utilization_bps(
    statement_balance_cents: object, current_balance_cents: object, limit_cents: object
) -> dict:
    statement = _opt_int(statement_balance_cents)
    current = _opt_int(current_balance_cents)
    limit = _opt_int(limit_cents)
    if limit is not None and limit < 0:
        raise RuleError("invalid_amount")
    balance = statement if statement is not None else current
    if balance is None or not limit:
        return {"utilization_bps": None, "balance_cents": balance}
    used = max(0, balance)
    return {"utilization_bps": ratio_bps(used, limit), "balance_cents": used}


def pay_in_full(
    as_of: str,
    statement_balance_cents: object,
    statement_date: object,
    last_payment_cents: object,
    last_payment_date: object,
    due_date: object,
    paydays: object,
) -> dict:
    today = parse_date(as_of)
    balance = _int(statement_balance_cents)
    stated = _opt_date(statement_date)
    last_paid = _opt_int(last_payment_cents)
    paid_on = _opt_date(last_payment_date)
    due = _opt_date(due_date)
    if not isinstance(paydays, list):
        raise RuleError("invalid_paydays")
    days = sorted({parse_date(d) for d in paydays})
    if last_paid is not None and last_paid < 0:
        raise RuleError("invalid_amount")

    paid = last_paid if (last_paid and paid_on and stated and paid_on >= stated) else 0
    remaining = max(0, balance - paid)
    out = {
        "status": "plan",
        "remaining_cents": remaining,
        "paid_cents": paid,
        "due_date": due.isoformat() if due else None,
        "days_left": days_until(today, due) if due else None,
        "payments": [],
    }
    if balance <= 0:
        out["status"] = "no_balance"
        return out
    if remaining == 0:
        out["status"] = "paid"
        return out
    if due is None:
        out["status"] = "no_due_date"
        return out
    if today > due:
        out["status"] = "past_due"
        return out
    window = [d for d in days if today <= d <= due]
    if not window:
        out["status"] = "no_payday"
        out["payments"] = [{"date": due.isoformat(), "amount_cents": remaining}]
        return out
    share, odd = divmod(remaining, len(window))
    out["payments"] = [
        {"date": d.isoformat(), "amount_cents": share + (1 if i < odd else 0)}
        for i, d in enumerate(window)
    ]
    return out
