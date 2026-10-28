"""The words someone reads and ticks before paying, switching or cancelling (docs/spec.md
"Plans & billing": "Before you subscribe", "Change your plan", "If you cancel").

The server is the only source (October 28, 2026): the app shows these lines as the server
built them and sends them back, and the billing routes rebuild them from the same facts and
refuse anything else (409 `consent_mismatch`), so a modified client can never store its own
text under a valid CONSENT_VERSION. The wording itself is unchanged from what the app built
before (apps/web PlanScreen, version 2026-10-24); a change to it bumps CONSENT_VERSION.

Pure: every input is passed in (prices from plans.yaml, the moment, the device's time zone).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# The "Before you subscribe" wording. Bump it whenever any line below changes; an app holding
# an older version gets 409 consent_outdated and loads the terms again.
CONSENT_VERSION = "2026-10-24"

# During a trial the first charge is on the trial-end day (owner decision, October 28, 2026),
# through Stripe's trial or, closer than 49 hours, a billing cycle anchored on the trial end.
# Under 31 minutes left the first charge is today (stripe_billing.ANCHOR_MIN, repeated here
# so this module stays pure).
ANCHOR_MIN = timedelta(minutes=31)

SHORT = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

PAY_WITH = (
    "A credit or debit card issued by a US bank (Visa, Mastercard, Amex, Discover), or a US bank "
    "account. Paid through Stripe; we never see your card or bank details. A bank payment takes "
    "up to 4 business days to clear, and the plan starts when it does."
)
CANCEL_AGREEMENT = "I have read and understood these terms."


@dataclass(frozen=True)
class Point:
    text: str
    icon: str | None = None  # price, renew, cancel, card, term, refund, unlink
    head: str | None = None  # the cancel sheet's one- or two-word headline


@dataclass(frozen=True)
class ConsentText:
    points: list[Point] = field(default_factory=list)
    agreement: str = ""

    @property
    def lines(self) -> list[str]:
        """What is sent back and kept: one line per point, its headline first when it has one."""
        return [f"{p.head}: {p.text}" if p.head else p.text for p in self.points]


def zone(name: str | None) -> tzinfo:
    """The device's time zone for dates; UTC when it sent none or one we don't know."""
    if not name:
        return UTC
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def money(cents: int) -> str:
    """4217 → "$42.17", 123456 → "$1,234.56" (as apps/web lib/format.ts formatCents)."""
    sign = "−" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100:,}.{cents % 100:02d}"


def day(at: datetime, tz: tzinfo) -> str:
    """A moment → "Oct 9, 2027" on the device's calendar (as formatDate)."""
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    local = at.astimezone(tz)
    return f"{SHORT[local.month - 1]} {local.day}, {local.year}"


def _price(plans: dict[str, Any], plan: str, interval: str) -> int:
    return int(plans["plans"][plan]["price_cents"][interval])


def _label(plans: dict[str, Any], plan: str) -> str:
    return str(plans["founding"]["label"] if plan == "founding" else plans["plans"][plan]["label"])


def agreement(plan: str, interval: str | None) -> str:
    """The box people tick."""
    if plan == "founding":
        return "I understand this is one payment for the whole term, and it doesn't renew."
    if interval == "yearly":
        return (
            "I understand my plan renews every year until I cancel, cancelling refunds nothing, "
            "and deleting my account early charges the months used at the monthly price."
        )
    return "I understand my plan renews every month until I cancel."


def _refund_point(plans: dict[str, Any], plan: str, interval: str) -> Point:
    """Leaving (owner decisions, October 17 and 22, 2026): a yearly plan deleted early pays the
    monthly price for the months used, this one included."""
    if interval == "yearly":
        monthly = money(_price(plans, plan, "monthly"))
        return Point(
            f"Delete your account early: the months used, this one included, cost the monthly "
            f"price ({monthly}); the rest of the year comes back, less Stripe's fee.",
            "refund",
        )
    return Point(
        "Delete your account: we keep this month; any credit comes back, less Stripe's fee.",
        "refund",
    )


def _switch_point(plans: dict[str, Any]) -> Point:
    days = int(plans["changes"]["downgrade_after_days"])
    return Point(
        f"Switch up any time for the difference. Switch down from {days} days in; the rest "
        "becomes credit.",
        "renew",
    )


def purchase(
    plans: dict[str, Any],
    plan: str,
    interval: str | None,
    *,
    trial_ends_at: datetime | None,
    now: datetime,
    tz: tzinfo,
) -> ConsentText:
    """ "Before you subscribe": what a new plan costs, how it renews, cancels and refunds."""
    if plan == "founding":
        founding = plans["founding"]
        return ConsentText(
            [
                Point(
                    f"{money(int(founding['one_time_cents']))} today, once. No renewal.", "price"
                ),
                Point(f"{int(founding['term_years'])} years of Connected, every feature.", "term"),
                Point("Before it ends, you pick a plan. Nothing is deleted.", "cancel"),
                Point(
                    "Delete your account: we keep this month and refund the rest, less Stripe's "
                    "fee.",
                    "refund",
                ),
                Point(PAY_WITH, "card"),
            ],
            agreement(plan, None),
        )
    assert interval in ("monthly", "yearly")
    per = "year" if interval == "yearly" else "month"
    price = money(_price(plans, plan, interval))
    if trial_ends_at is not None and trial_ends_at.tzinfo is None:
        trial_ends_at = trial_ends_at.replace(tzinfo=UTC)
    # During a trial the card is saved now and first charged when the trial ends (the
    # checkout passes the same end).
    trial = (
        day(trial_ends_at, tz)
        if trial_ends_at is not None and trial_ends_at - now >= ANCHOR_MIN
        else None
    )
    points = [
        Point(
            f"Free until {trial}, then {price} every {per}."
            if trial
            else f"{price} today, then every {per}.",
            "price",
        ),
        Point(f"Renews automatically each {per} until you cancel.", "renew"),
    ]
    if interval == "yearly":
        twelve = money(12 * _price(plans, plan, "monthly"))
        points += [
            Point(
                f"Yearly costs less than 12 monthly payments ({twelve}) only if you stay the year.",
                "term",
            ),
            Point(
                "Cancel any time in Me → Plan. It runs to the end of the paid year; nothing is "
                "refunded.",
                "cancel",
            ),
        ]
    else:
        points.append(Point("Cancel any time in Me → Plan. It runs to the month's end.", "cancel"))
    points += [_switch_point(plans), _refund_point(plans, plan, interval), Point(PAY_WITH, "card")]
    return ConsentText(points, agreement(plan, interval))


def change(
    plans: dict[str, Any],
    plan: str,
    interval: str,
    *,
    kind: str,
    due_now_cents: int,
    credit_after_cents: int,
    disconnects_banks: bool,
    current_plan: str,
) -> ConsentText:
    """ "Change your plan": what a switch means, in the same short lines (October 17, 2026)."""
    per = "year" if interval == "yearly" else "month"
    price = money(_price(plans, plan, interval))
    name = _label(plans, plan)
    days = int(plans["changes"]["downgrade_after_days"])
    if kind == "up":
        points = [
            Point(
                f"{money(due_now_cents)} today: {name} less what's left of "
                f"{_label(plans, current_plan)}.",
                "price",
            ),
            Point(
                f"{name} · {interval} starts now. Switching down again opens in {days} days.",
                "term",
            ),
        ]
    else:
        points = [
            Point(
                f"Nothing today. {money(credit_after_cents)} credit pays your next bills."
                if credit_after_cents > 0
                else "Nothing is charged today.",
                "price",
            ),
            Point(f"{name} · {interval} starts now.", "term"),
        ]
    if disconnects_banks:
        points.append(
            Point(
                f"{name} doesn't link banks: yours are disconnected now. Accounts and entries "
                "stay.",
                "unlink",
            )
        )
    points += [
        Point(f"Then {price} every {per} until you cancel.", "renew"),
        _refund_point(plans, plan, interval),
    ]
    return ConsentText(points, agreement(plan, interval))


def cancel(
    plans: dict[str, Any],
    plan: str,
    *,
    renews_at: datetime | None,
    refund_if_deleted_cents: int,
    tz: tzinfo,
) -> ConsentText:
    """ "If you cancel" (owner, October 18, 2026): a headline per point, then a short line."""
    until = day(renews_at, tz) if renews_at is not None else "the paid period ends"
    points = [
        Point(f"{_label(plans, plan)} runs until {until}.", head="Stays on"),
        Point("Nothing more is billed after that.", head="No charges"),
        Point(
            "Then subscribe again or download your data.",
            head=f"{int(plans['trials']['grace_days'])}-day grace",
        ),
        Point("Account and data go; leftover credit is refunded.", head="Then deleted"),
    ]
    # Only when deleting would pay something back (none during a trial or on a monthly plan).
    if refund_if_deleted_cents > 0:
        points.append(
            Point(
                f"Delete your account instead: {money(refund_if_deleted_cents)} back.",
                head="Want money back?",
            )
        )
    return ConsentText(points, CANCEL_AGREEMENT)
