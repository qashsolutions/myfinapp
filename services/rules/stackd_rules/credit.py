"""Credit cards from linked card details (chunk 3.5; docs/spec.md "Calculation rules": Card
utilisation, Pay in full by the due date). Read-only facts and a plan; nothing moves money.

utilization_bps   statement balance (else current) ÷ limit in bps, half-even; null without a
                  limit; a credit balance counts as 0; may pass 10000.
pay_in_full       what is left of the statement balance after a payment made since the
                  statement, split across the paydays from as_of through the due date (the
                  first ones carry the odd cents), else one payment on the due date.
"""

from __future__ import annotations

from . import forecast
from .dates import add_months, days_in_month, days_until, parse_date
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


# --- card trend and credit habits (debt & credit, October 28, 2026) ---------------------------

MAX_WINDOW_MONTHS = 120  # ten years of months is the most either rule looks back


def _window_months(value: object) -> int:
    months = _int(value, "invalid_months")
    if not 1 <= months <= MAX_WINDOW_MONTHS:
        raise RuleError("invalid_months")
    return months


def _month_key(d) -> str:
    return d.isoformat()[:7]


def _card_entry(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise RuleError("invalid_entry")
    direction = raw.get("direction")
    if direction not in ("in", "out"):
        raise RuleError("invalid_direction")
    cents = _int(raw.get("amount_cents"), "invalid_amount")
    if cents < 0:
        raise RuleError("invalid_amount")
    return {"date": parse_date(raw.get("date")), "direction": direction, "cents": cents}


def card_trend(entries: object, as_of: str, months: object) -> dict:
    """One card's money out (spent) against money in (paid) per whole calendar month.

    The caller passes every entry of the card account (Don't count included: the balance moves
    either way); money in is payments, refunds and transfers in. Months run oldest first over
    the `months` complete months before as_of's month, from the month of the first entry on.
    trend: "growing" when spent > paid in each of the last 3 complete months, "shrinking" when
    paid > spent in each, else "steady"; null with fewer than 3 complete months of history.
    """
    today = parse_date(as_of)
    span = _window_months(months)
    if not isinstance(entries, list):
        raise RuleError("invalid_entries")
    rows = [_card_entry(e) for e in entries]
    this_month = today.replace(day=1)
    first_entry = min((r["date"] for r in rows), default=None)
    out_months: list[dict] = []
    for back in range(span, 0, -1):
        start = add_months(this_month, -back)
        if first_entry is None or start < first_entry.replace(day=1):
            continue
        key = _month_key(start)
        spent = sum(
            r["cents"] for r in rows if r["direction"] == "out" and _month_key(r["date"]) == key
        )
        paid = sum(
            r["cents"] for r in rows if r["direction"] == "in" and _month_key(r["date"]) == key
        )
        out_months.append(
            {"month": key, "spent_cents": spent, "paid_cents": paid, "net_cents": spent - paid}
        )
    trend = None
    if len(out_months) >= 3:
        last3 = out_months[-3:]
        if all(m["spent_cents"] > m["paid_cents"] for m in last3):
            trend = "growing"
        elif all(m["paid_cents"] > m["spent_cents"] for m in last3):
            trend = "shrinking"
        else:
            trend = "steady"
    return {
        "months": out_months,
        "last_month": out_months[-1] if out_months else None,
        "trend": trend,
    }


def _payment(raw: object) -> tuple:
    if not isinstance(raw, dict):
        raise RuleError("invalid_payment")
    cents = _int(raw.get("cents"), "invalid_amount")
    if cents < 0:
        raise RuleError("invalid_amount")
    return parse_date(raw.get("date")), cents


def habits(
    due_dates: object,
    due_day: object,
    payments: object,
    minimum_cents: object,
    statements: object,
    statement_balance_cents: object,
    current_balance_cents: object,
    limit_cents: object,
    as_of: str,
    months: object,
    guide_bps: object,
    since: object = None,
    balance_history: object = None,
    until: object = None,
) -> dict:
    """On-time payments, the share of the limit used and paying in full, for one card.

    Due dates are the given ones, those of `statements` ({due_date, balance_cents?,
    minimum_cents?}: what that statement asked for), plus, with `due_day` (1-31), that day of
    every month clamped to the month's end, in the months that have no given or statement due
    date. A due date is checked when it is on or after as_of
    minus `months` months, on or after `since` when given (the card's history starts there, so
    nothing before it counts as missed) and before as_of (a due date of today is still open).
    It is on time
    when the payments dated after the previous due date (or, for the first one known, after
    the same day a month before) and on or before it add up to its minimum (the statement's,
    else `minimum_cents`) when known and above 0, else to more than 0; or when its statement
    balance is known and nothing was owed. It is paid in full when that sum reaches its known
    statement balance.

    With `balance_history` ({anchors: [{as_of, balance_cents}], entries: [{date, direction,
    amount_cents}]}, a card that isn't linked; balances as the device keeps them, below zero is
    owed) a due date with no statement balance takes what was owed on it: the latest anchor on
    or before it plus the entries after the anchor through the due date (forecast.start_balance),
    owed = max(0, -balance). Nothing owed is on time and paid in full; something owed needs a
    payment as above, and paid in full stays unknown. A due date with no anchor on or before
    it is unknown: left out of `checked` and counted in `unknown`, never missed. So is a due
    date after `until`, the last day the card's data reaches (its latest import, entry, balance
    or sync), unless the payments already seen make it on time: its payment may not be in yet.
    We say only what the person's own data shows.

    `dues` lists every due date in the window in date order with its result, on_time, missed
    or unknown (October 29, 2026: the dot strip on Credit habits).
    """
    today = parse_date(as_of)
    span = _window_months(months)
    guide = _int(guide_bps, "invalid_amount")
    if guide < 0:
        raise RuleError("invalid_amount")
    first = _opt_date(since)
    if not isinstance(due_dates, list):
        raise RuleError("invalid_dates")
    if not isinstance(payments, list):
        raise RuleError("invalid_payments")
    dues = {parse_date(d) for d in due_dates}
    start = add_months(today, -span)
    last = _opt_date(until)
    day = None if due_day is None else _int(due_day, "invalid_day")
    if day is not None and not 1 <= day <= 31:
        raise RuleError("invalid_day")
    minimum = _opt_int(minimum_cents)
    if minimum is not None and minimum < 0:
        raise RuleError("invalid_amount")
    owed_by_due: dict = {}
    minimum_by_due: dict = {}
    if statements is not None:
        if not isinstance(statements, list):
            raise RuleError("invalid_statements")
        for raw in statements:
            if not isinstance(raw, dict):
                raise RuleError("invalid_statements")
            due = parse_date(raw.get("due_date"))
            dues.add(due)
            owed = _opt_int(raw.get("balance_cents"))
            if owed is not None:
                owed_by_due[due] = owed
            own_min = _opt_int(raw.get("minimum_cents"))
            if own_min is not None:
                if own_min < 0:
                    raise RuleError("invalid_amount")
                minimum_by_due[due] = own_min
    if day is not None:
        # The person's own due day fills only months with no known due date (a statement's
        # or a given one): one bill a month, never a second, earlier one that looks missed.
        # From the month before the window (so the first checked one has a previous) through
        # the month after as_of (so the next due date is known).
        known = {(d.year, d.month) for d in dues}
        lead = add_months(start.replace(day=1), -1)
        for step in range(span + 3):
            month = add_months(lead, step)
            if (month.year, month.month) not in known:
                dues.add(month.replace(day=min(day, days_in_month(month))))
    paid = [_payment(p) for p in payments]
    history = _balance_history(balance_history)

    ordered = sorted(dues)
    window = [d for d in ordered if start <= d < today and (first is None or d >= first)]
    checked = []
    unknown = 0
    unknown_dates = set()
    for d in window:
        if history is not None and d not in owed_by_due:
            owed_then = _owed_on(history, d)
            if owed_then is None:
                unknown += 1
                unknown_dates.add(d)
                continue
            if owed_then == 0:
                owed_by_due[d] = 0
        checked.append(d)
    results = []
    for d in checked:
        earlier = [x for x in ordered if x < d]
        after = earlier[-1] if earlier else add_months(d, -1)
        total = sum(c for when, c in paid if after < when <= d)
        owed = owed_by_due.get(d)
        need = minimum_by_due.get(d, minimum)
        if owed is not None and owed <= 0:
            on_time, in_full = True, True
        else:
            on_time = total >= need if need else total > 0
            in_full = None if owed is None else total >= owed
        if not on_time and last is not None and d > last:
            # Past what the card's data reaches: its payment may simply not be in yet.
            unknown += 1
            unknown_dates.add(d)
            continue
        results.append({"due_date": d, "on_time": on_time, "in_full": in_full})

    streak = 0
    for r in reversed(results):
        if not r["on_time"]:
            break
        streak += 1
    full_streak = None
    for r in reversed(results):
        if r["in_full"] is None:
            break
        if not r["in_full"]:
            full_streak = full_streak or 0
            break
        full_streak = (full_streak or 0) + 1
    missed = [r["due_date"].isoformat() for r in results if not r["on_time"]]
    if not results:
        status = None
    elif streak == len(results):
        status = "steady"
    elif not results[-1]["on_time"]:
        status = "missed"
    else:
        status = "building"
    upcoming = [d for d in ordered if d >= today]
    by_date = {r["due_date"]: ("on_time" if r["on_time"] else "missed") for r in results}
    dues_out = [
        {"due_date": d.isoformat(), "result": "unknown" if d in unknown_dates else by_date[d]}
        for d in window
    ]
    util = utilization_bps(statement_balance_cents, current_balance_cents, limit_cents)[
        "utilization_bps"
    ]
    return {
        "status": status,
        "checked": len(results),
        "unknown": unknown,
        "on_time": sum(1 for r in results if r["on_time"]),
        "on_time_streak": streak,
        "missed": missed,
        "latest_due_date": results[-1]["due_date"].isoformat() if results else None,
        "next_due_date": upcoming[0].isoformat() if upcoming else None,
        "paid_in_full_streak": full_streak,
        "utilization_bps": util,
        "under_guide": None if util is None else util <= guide,
        "dues": dues_out,
    }


def _balance_history(raw: object) -> dict | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise RuleError("invalid_history")
    anchors = raw.get("anchors")
    entries = raw.get("entries")
    if not isinstance(anchors, list) or not isinstance(entries, list):
        raise RuleError("invalid_history")
    parsed = []
    for i, a in enumerate(anchors):
        if not isinstance(a, dict):
            raise RuleError("invalid_anchor")
        parsed.append((parse_date(a.get("as_of")), i, a))
    rows = [_card_entry(e) for e in entries]
    return {"anchors": parsed, "entries": entries, "rows": rows}


def _owed_on(history: dict, day) -> int | None:
    """What was owed at the end of `day`, or None with no anchor on or before it. The latest
    anchor wins; two on the same day, the later one given."""
    before = [a for a in history["anchors"] if a[0] <= day]
    if not before:
        return None
    anchor = max(before, key=lambda a: (a[0], a[1]))[2]
    upto = [e for e, r in zip(history["entries"], history["rows"], strict=True) if r["date"] <= day]
    balance = forecast.start_balance(anchor, upto)["balance_cents"]
    return max(0, -balance)
