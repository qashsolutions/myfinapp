"""Recurring series detection (docs/spec.md "Upcoming expenses & shortfall forecast").

Recurring series   same payee, amount within ±10% of the series median, at least 3 occurrences
                   at a weekly (7 ±3 days), every-2-weeks (14 ±3) or monthly (28–31 ±3)
                   interval, or at least 2 at a quarterly (80–100 days) or yearly (350–380)
                   one (fast-follow 8). Suggested only; the user confirms, edits or dismisses.

The payee is the entry's bank text as its merchant key (`fingerprint.merchant_key`: cleaned like
a fingerprint, then web endings, processor prefixes and store numbers dropped), so "Netflix.com",
"NETFLIX.COM 866-579-7172" and "netflix" are one payee (owner, October 29, 2026). The device
passes the bank's text, never a name the person gave the entry (invariant 47). Only the most
recent run of evenly spaced occurrences counts: a payee whose spacing changed is judged on the
new pattern.
Transfers are never bills.
"""

from __future__ import annotations

from datetime import date, timedelta

from . import dates, money
from .errors import RuleError
from .fingerprint import clean_description, merchant_key
from .money import _int

INTERVALS = ("weekly", "biweekly", "monthly", "quarterly", "yearly")
GAPS = {
    "weekly": (4, 10),
    "biweekly": (11, 17),
    "monthly": (25, 34),
    "quarterly": (80, 100),
    "yearly": (350, 380),
}
MIN_RUN = {"weekly": 3, "biweekly": 3, "monthly": 3, "quarterly": 2, "yearly": 2}
DIRECTIONS = ("in", "out")


def _entry(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise RuleError("invalid_entry")
    day = dates.parse_date(raw.get("date"))
    cents = _int(raw.get("amount_cents"))
    if cents < 0:
        raise RuleError("invalid_amount")
    if raw.get("direction") not in DIRECTIONS:
        raise RuleError("invalid_direction")
    if not isinstance(raw.get("is_transfer"), bool):
        raise RuleError("invalid_entry")
    entry_id = raw.get("id")
    if entry_id is not None and not isinstance(entry_id, str):
        raise RuleError("invalid_entry")
    payee = merchant_key(raw.get("payee"))
    return {
        "id": entry_id,
        "date": day,
        "cents": cents,
        "direction": raw["direction"],
        "is_transfer": raw["is_transfer"],
        "payee": payee,
    }


def entries(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        raise RuleError("invalid_entries")
    return [_entry(e) for e in raw]


def interval_of(gap_days: int) -> str | None:
    for name in INTERVALS:
        lo, hi = GAPS[name]
        if lo <= gap_days <= hi:
            return name
    return None


def step_keeping_day(day: date, interval: str, keep: int | None) -> date:
    """One step on, back on the series' own day of the month (1-31, clamped to the month) when
    it has one, so stepping from a short month never drifts it earlier (forecast.upcoming's
    `day`, subscription_check's renewals)."""
    day = step(day, interval)
    if keep is not None and interval in ("monthly", "quarterly", "yearly"):
        day = day.replace(day=min(keep, dates.days_in_month(day)))
    return day


def step(day: date, interval: str) -> date:
    if interval == "weekly":
        return day + timedelta(days=7)
    if interval == "biweekly":
        return day + timedelta(days=14)
    if interval == "monthly":
        return dates.add_months(day, 1)
    if interval == "quarterly":
        return dates.add_months(day, 3)
    if interval == "yearly":
        return dates.add_months(day, 12)
    raise RuleError("invalid_interval")


def median_cents(values: list[int]) -> int:
    ordered = sorted(values)
    n = len(ordered)
    if n % 2:
        return ordered[n // 2]
    return money.round_div(ordered[n // 2 - 1] + ordered[n // 2], 2)


def within_ten_percent(cents: int, reference: int) -> bool:
    return 9 * reference <= 10 * cents <= 11 * reference


LAST_DAY = 31  # a day of the month that means the month's last day

# Twice a month (October 29, 2026, invariant 49): pay on two fixed days of the month (the 1st
# and 15th, the 15th and the last day), moved a few days by weekends and holidays.
SEMIMONTHLY = "semimonthly"
SEMIMONTHLY_GAPS = (10, 20)  # days between paydays once weekends and holidays move them
SEMIMONTHLY_MIN_RUN = 4


def day_of_month(day: date) -> int:
    """The day of the month a date stands for: its own, or 31 when it is the month's last day."""
    return LAST_DAY if day.day == dates.days_in_month(day) else day.day


def usual_day(run: list[dict]) -> int:
    """The run's most common day of the month (the last day counted as 31); a tie goes to the
    one the latest occurrence had."""
    counts: dict[int, int] = {}
    last_seen: dict[int, int] = {}
    for index, e in enumerate(run):
        d = day_of_month(e["date"])
        counts[d] = counts.get(d, 0) + 1
        last_seen[d] = index
    return max(counts, key=lambda d: (counts[d], last_seen[d]))


def _target(year: int, month: int, keep: int) -> date:
    first = date(year, month, 1)
    return first.replace(day=min(keep, dates.days_in_month(first)))


def _off_by(day: date, target: date) -> int:
    """Days between a payday and the day it was due; 0 when a weekend moved it to the Friday
    before or the Monday after."""
    gap = (day - target).days
    weekday = target.weekday()  # Monday 0 ... Sunday 6
    if weekday == 5 and gap in (-1, 2):
        return 0
    if weekday == 6 and gap in (-2, 1):
        return 0
    return abs(gap)


def _months_around(day: date) -> list[tuple[int, int]]:
    before = dates.add_months(day, -1)
    after = dates.add_months(day, 1)
    return [(before.year, before.month), (day.year, day.month), (after.year, after.month)]


def _nearest(day: date, keep: int) -> tuple[int, date]:
    """How far a payday is from `keep` in its month or the months either side, and that due
    date (the earliest of equals)."""
    options = [_target(y, m, keep) for y, m in _months_around(day)]
    return min(((_off_by(day, t), t) for t in options), key=lambda o: (o[0], o[1]))


def _best_day(half: list[date]) -> tuple[int, int]:
    """(off-by total, day 1-31) for one half of a twice-a-month run: the day with the smallest
    total; a tie goes to the later day, since weekends move pay earlier."""
    return min(
        ((sum(_nearest(d, keep)[0] for d in half), keep) for keep in range(1, LAST_DAY + 1)),
        key=lambda o: (o[0], -o[1]),
    )


def _every_two_weeks_off_by(run: list[date]) -> int:
    """How far a run is from one payday every 14 days, from its best start (lower median)."""
    offsets = sorted((d - run[0]).days - 14 * i for i, d in enumerate(run))
    middle = offsets[(len(offsets) - 1) // 2]
    return sum(abs((d - run[0]).days - 14 * i - middle) for i, d in enumerate(run))


def _semimonthly(items: list[dict]) -> dict | None:
    """The most recent twice-a-month run, or None: at least 4 paydays with 10-20 days between
    them, alternating between two days of the month, that fit those two days better than they
    fit one payday every 14 days."""
    lo, hi = SEMIMONTHLY_GAPS
    start = len(items) - 1
    while start > 0 and lo <= (items[start]["date"] - items[start - 1]["date"]).days <= hi:
        start -= 1
    run = items[start:]
    if len(run) < SEMIMONTHLY_MIN_RUN:
        return None
    days = [e["date"] for e in run]
    off_a, day_a = _best_day(days[0::2])
    off_b, day_b = _best_day(days[1::2])
    if day_a == day_b or off_a + off_b >= _every_two_weeks_off_by(days):
        return None
    keeps = sorted((day_a, day_b))
    last_keep = day_a if (len(run) - 1) % 2 == 0 else day_b
    due = _nearest(days[-1], last_keep)[1]
    later = [
        _target(y, m, keep)
        for y, m in (
            (due.year, due.month),
            (dates.add_months(due, 1).year, dates.add_months(due, 1).month),
        )
        for keep in keeps
    ]
    next_due = min(t for t in later if t > due)
    return {"run": run, "days": keeps, "next": next_due}


def detect(entries_in: list, as_of: str) -> dict:
    today = dates.parse_date(as_of)
    rows = [e for e in entries(entries_in) if not e["is_transfer"] and e["date"] <= today]
    groups: dict[tuple[str, str], list[dict]] = {}
    for e in rows:
        groups.setdefault((e["payee"], e["direction"]), []).append(e)
    series = []
    for (payee, direction), items in sorted(groups.items()):
        items.sort(key=lambda e: (e["date"], e["cents"], e["id"] or ""))
        if len(items) < 2:
            continue
        twice = _semimonthly(items)
        if twice is not None:
            run = twice["run"]
            expected = median_cents([e["cents"] for e in run])
            if all(within_ten_percent(e["cents"], expected) for e in run):
                series.append(
                    {
                        "payee": payee,
                        "kind": "income" if direction == "in" else "bill",
                        "direction": direction,
                        "expected_cents": expected,
                        "interval": SEMIMONTHLY,
                        "day": None,
                        "days": twice["days"],
                        "last_date": run[-1]["date"].isoformat(),
                        "next_date": twice["next"].isoformat(),
                        "occurrences": len(run),
                        "entry_ids": [e["id"] for e in run if e["id"] is not None],
                    }
                )
                continue
        last_gap = (items[-1]["date"] - items[-2]["date"]).days
        interval = interval_of(last_gap)
        if interval is None:
            continue
        lo, hi = GAPS[interval]
        start = len(items) - 2
        while start > 0 and lo <= (items[start]["date"] - items[start - 1]["date"]).days <= hi:
            start -= 1
        run = items[start:]
        if len(run) < MIN_RUN[interval]:
            continue
        expected = median_cents([e["cents"] for e in run])
        if not all(within_ten_percent(e["cents"], expected) for e in run):
            continue
        last = run[-1]["date"]
        # A month-based bill keeps its usual day (October 29, 2026, invariant 49): rent on the
        # 30th, 31st and 31st is due on the last day, so February's 28th never drifts it.
        keep = usual_day(run) if interval in ("monthly", "quarterly", "yearly") else None
        series.append(
            {
                "payee": payee,
                "kind": "income" if direction == "in" else "bill",
                "direction": direction,
                "expected_cents": expected,
                "interval": interval,
                "day": keep,
                "days": None,
                "last_date": last.isoformat(),
                "next_date": step_keeping_day(last, interval, keep).isoformat(),
                "occurrences": len(run),
                "entry_ids": [e["id"] for e in run if e["id"] is not None],
            }
        )
    return {"series": series}


PER_YEAR = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "yearly": 1}
MAX_SAFE_CENTS = 2**53 - 1  # past this the TypeScript port cannot count exactly


def yearly_cost(series_in: object) -> dict:
    """What each recurring charge costs a year (the Subscriptions view, owner October 27, 2026).

    yearly = expected × charges a year (weekly 52, every 2 weeks 26, monthly 12, quarterly 4,
    yearly 1); monthly = yearly ÷ 12, half-even. Sorted by yearly cost, highest first, then label
    and id in code-point order. Totals are the sums; the total monthly is total yearly ÷ 12.
    Past 2^53 − 1 cents a year it answers invalid_amount, so both engines agree.
    """
    if not isinstance(series_in, list):
        raise RuleError("invalid_series")
    items = []
    for raw in series_in:
        if not isinstance(raw, dict):
            raise RuleError("invalid_series")
        sid, label = raw.get("id"), raw.get("label")
        if not isinstance(sid, str) or not isinstance(label, str):
            raise RuleError("invalid_series")
        interval = raw.get("interval")
        if not isinstance(interval, str) or interval not in PER_YEAR:
            raise RuleError("invalid_interval")
        cents = _int(raw.get("expected_cents"), "invalid_amount")
        if cents < 0:
            raise RuleError("invalid_amount")
        yearly = cents * PER_YEAR[interval]
        if yearly > MAX_SAFE_CENTS:
            raise RuleError("invalid_amount")
        items.append(
            {
                "id": sid,
                "label": label,
                "yearly_cents": yearly,
                "monthly_cents": money.round_div(yearly, 12),
            }
        )
    items.sort(key=lambda i: (-i["yearly_cents"], i["label"], i["id"]))
    total = sum(i["yearly_cents"] for i in items)
    if total > MAX_SAFE_CENTS:
        raise RuleError("invalid_amount")
    return {
        "items": items,
        "yearly_cents": total,
        "monthly_cents": money.round_div(total, 12),
    }


CHECK_THRESHOLDS = (
    "subscription_ask_days",
    "subscription_renewal_days",
    "trial_max_cents",
    "trial_window_days",
)


def _thresholds(raw: object) -> dict[str, int]:
    if not isinstance(raw, dict):
        raise RuleError("invalid_thresholds")
    out = {}
    for key in CHECK_THRESHOLDS:
        value = raw.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise RuleError("invalid_thresholds")
        out[key] = value
    return out


def _kinds(raw: object) -> list[tuple[str, str]]:
    if not isinstance(raw, list):
        raise RuleError("invalid_kinds")
    table = []
    for row in raw:
        if not isinstance(row, dict):
            raise RuleError("invalid_kinds")
        word, kind = row.get("match"), row.get("kind")
        if not isinstance(word, str) or not isinstance(kind, str) or not kind:
            raise RuleError("invalid_kinds")
        cleaned = clean_description(word)
        if not cleaned:
            raise RuleError("invalid_kinds")
        table.append((cleaned, kind))
    return table


def _is_word_char(ch: str) -> bool:
    return ("A" <= ch <= "Z") or ("0" <= ch <= "9")


def contains_word(text: str, word: str) -> bool:
    """`word` inside `text` as a whole word: the characters just before and after it, when there
    are any, are not A-Z or 0-9 (the cleaned payee is upper-case ASCII), so GYM is in "GOLDS GYM"
    and "GYM-24" but never in "GYMBOREE". Every place the word appears is tried. An empty
    word is never in anything."""
    if not word:
        return False
    start = text.find(word)
    while start != -1:
        end = start + len(word)
        before_ok = start == 0 or not _is_word_char(text[start - 1])
        after_ok = end == len(text) or not _is_word_char(text[end])
        if before_ok and after_ok:
            return True
        start = text.find(word, start + 1)
    return False


OTHER_KIND = "other"  # the person's "Other": no kind, whatever the table says


def _own_kind(raw: object, known: set[str]) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw:
        raise RuleError("invalid_kind")
    if raw != OTHER_KIND and raw not in known:
        raise RuleError("invalid_kind")
    return raw


def _own_kinds(raw: object, builtin: set[str]) -> set[str]:
    """The person's own kinds (October 29, 2026): ids made on the device, each text, not empty,
    not Other, not one of the table's kinds and not twice. Their names stay on the device."""
    if raw is None:
        return set()
    if not isinstance(raw, list):
        raise RuleError("invalid_own_kinds")
    out: set[str] = set()
    for kind in raw:
        if not isinstance(kind, str) or not kind or kind == OTHER_KIND:
            raise RuleError("invalid_own_kinds")
        if kind in builtin or kind in out:
            raise RuleError("invalid_own_kinds")
        out.add(kind)
    return out


def _own_words(raw: object, known: set[str]) -> list[tuple[str, str]]:
    """The person's own words (October 29, 2026): cleaned like the table's, each naming a kind
    from the table or one of their own (else `invalid_kind`), tried before the table."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RuleError("invalid_own_words")
    words = []
    for row in raw:
        if not isinstance(row, dict):
            raise RuleError("invalid_own_words")
        word, kind = row.get("match"), row.get("kind")
        if not isinstance(word, str) or not isinstance(kind, str):
            raise RuleError("invalid_own_words")
        cleaned = clean_description(word)
        if not cleaned:
            raise RuleError("invalid_own_words")
        if kind not in known:
            raise RuleError("invalid_kind")
        words.append((cleaned, kind))
    return words


def _charges(raw: object) -> list[tuple[date, int]]:
    if not isinstance(raw, list):
        raise RuleError("invalid_charges")
    out = []
    for c in raw:
        if not isinstance(c, dict):
            raise RuleError("invalid_charges")
        cents = _int(c.get("cents"), "invalid_amount")
        if cents < 0:
            raise RuleError("invalid_amount")
        out.append((dates.parse_date(c.get("date")), cents))
    return out


def _answered_since(checked: date | None, day: date) -> bool:
    return checked is not None and checked >= day


def subscription_check(
    as_of: str,
    subscriptions: object,
    kinds: object,
    thresholds: object,
    own_words: object = None,
    own_kinds: object = None,
) -> dict:
    """Facts from the person's own charges, and when to ask "still using it?" (docs/spec.md
    "Subscriptions", Subscription check). Never a judgement about use: Qash cannot see it."""
    today = dates.parse_date(as_of)
    limits = _thresholds(thresholds)
    table = _kinds(kinds)
    builtin = {k for _, k in table}
    known = builtin | _own_kinds(own_kinds, builtin)
    # The person's words first, so their call wins over the table; a kind set by hand wins over
    # both.
    words = _own_words(own_words, known) + table
    if not isinstance(subscriptions, list):
        raise RuleError("invalid_series")
    items = []
    for raw in subscriptions:
        if not isinstance(raw, dict):
            raise RuleError("invalid_series")
        sid, label, payee = raw.get("id"), raw.get("label"), raw.get("payee")
        if not isinstance(sid, str) or not isinstance(label, str) or not isinstance(payee, str):
            raise RuleError("invalid_series")
        interval = raw.get("interval")
        if not isinstance(interval, str) or interval not in PER_YEAR:
            raise RuleError("invalid_interval")
        expected = _int(raw.get("expected_cents"), "invalid_amount")
        if expected < 0:
            raise RuleError("invalid_amount")
        yearly = expected * PER_YEAR[interval]
        if yearly > MAX_SAFE_CENTS:
            raise RuleError("invalid_amount")
        next_date = dates.parse_date(raw.get("next_date"))
        checked_raw = raw.get("checked_at")
        checked = None if checked_raw is None else dates.parse_date(checked_raw)
        charges = sorted(c for c in _charges(raw.get("charges")) if c[0] <= today)

        # A trial: the first charge is at most trial_max_cents and the next one, larger, follows
        # within trial_window_days. That step up is the trial ending, never a price rise.
        trial_pair = (
            len(charges) >= 2
            and charges[0][1] <= limits["trial_max_cents"]
            and charges[1][1] > charges[0][1]
            and (charges[1][0] - charges[0][0]).days <= limits["trial_window_days"]
        )
        trial = None
        if trial_pair and not _answered_since(checked, charges[1][0]):
            trial = {
                "trial_cents": charges[0][1],
                "cents": charges[1][1],
                "date": charges[1][0].isoformat(),
            }
        # A price rise: the most recent charge above the one before it, shown while every
        # charge since is at that new price and the person has not answered (Keep) on or after
        # the day it went up. A trial ending is never one; a later drop clears it.
        rise = None
        up = next(
            (i for i in range(len(charges) - 1, 0, -1) if charges[i][1] > charges[i - 1][1]),
            None,
        )
        if (
            up is not None
            and not (trial_pair and up == 1)
            and charges[-1][1] == charges[up][1]
            and not _answered_since(checked, charges[up][0])
        ):
            rise = {
                "from_cents": charges[up - 1][1],
                "to_cents": charges[-1][1],
                "date": charges[up][0].isoformat(),
            }
        renewal = None
        if interval in ("quarterly", "yearly"):
            due = next_date
            while due < today:
                due = step_keeping_day(due, interval, next_date.day)
            if (due - today).days <= limits["subscription_renewal_days"]:
                renewal = {"date": due.isoformat(), "cents": expected}
        last_charge = charges[-1][0] if charges else None
        ask = (
            checked is None
            or (today - checked).days >= limits["subscription_ask_days"]
            or (
                renewal is not None
                and last_charge is not None
                and not _answered_since(checked, last_charge)
            )
            or rise is not None
            or trial is not None
        )
        own = _own_kind(raw.get("own_kind"), known)
        if own is not None:
            kind = None if own == OTHER_KIND else own
        else:
            # The cleaned payee or its merchant key ("UBER *EATS" reads as UBER EATS).
            clean = clean_description(payee)
            key = merchant_key(payee)
            kind = next(
                (k for word, k in words if contains_word(clean, word) or contains_word(key, word)),
                None,
            )
        items.append(
            {
                "id": sid,
                "label": label,
                "kind": kind,
                "ask": ask,
                "price_rise": rise,
                "renewal": renewal,
                "trial_turned_charge": trial,
                "yearly_cents": yearly,
                "monthly_cents": money.round_div(yearly, 12),
            }
        )
    items.sort(key=lambda i: (-i["yearly_cents"], i["label"], i["id"]))
    groups: dict[str, list[dict]] = {}
    for i in items:
        if i["kind"] is not None:
            groups.setdefault(i["kind"], []).append(i)
    duplicates = []
    for kind, members in groups.items():
        if len(members) < 2:
            continue
        total = sum(m["yearly_cents"] for m in members)
        if total > MAX_SAFE_CENTS:
            raise RuleError("invalid_amount")
        duplicates.append(
            {
                "kind": kind,
                "count": len(members),
                "monthly_total_cents": money.round_div(total, 12),
                "ids": [m["id"] for m in members],
            }
        )
    duplicates.sort(key=lambda d: (-d["monthly_total_cents"], d["kind"]))
    # Where the money goes, by kind (October 29, 2026): every kind held, and the subscriptions
    # with no kind as one row (kind null), by yearly cost; ties by kind, the no-kind row last.
    held: dict[str | None, list[dict]] = {}
    for i in items:
        held.setdefault(i["kind"], []).append(i)
    by_kind = []
    for kind, members in held.items():
        total = sum(m["yearly_cents"] for m in members)
        if total > MAX_SAFE_CENTS:
            raise RuleError("invalid_amount")
        by_kind.append(
            {
                "kind": kind,
                "count": len(members),
                "yearly_cents": total,
                "monthly_cents": money.round_div(total, 12),
                "ids": [m["id"] for m in members],
            }
        )
    by_kind.sort(key=lambda k: (-k["yearly_cents"], k["kind"] is None, k["kind"] or ""))
    return {"items": items, "duplicates": duplicates, "by_kind": by_kind}
