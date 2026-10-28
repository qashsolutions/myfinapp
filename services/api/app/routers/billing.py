"""Plans and billing (docs/spec.md "Plans & billing", "Founding member offer").

- GET /api/billing: the plan, its status and dates, the prices from plans.yaml, the limits
- POST /api/billing/checkout: a Stripe Checkout URL (step-up: a plan change is sensitive)
- POST /api/billing/change/preview, /change: switch plan or billing period at once; an upgrade
  is charged the difference, a downgrade leaves the unused part as credit for the next bills,
  and a downgrade opens 30 days after the plan started or last changed (owner decision,
  October 17, 2026)
- GET /api/billing/credit: credit on the account, and what deleting it now would refund
- POST /api/billing/tester: an admin (STACKD_ADMIN_EMAILS) switches their own plan for free to
  test it; 404 for everyone else (owner decision, October 18, 2026)
- POST /api/billing/portal: the Customer Portal URL for receipts and the card on file
- POST /api/billing/cancel, /resume: stop or restart renewal; a cancelled plan keeps working
  until the end of the period already paid for (owner decision, October 13, 2026)
- GET /api/billing/entitlements: the limits the app enforces on the device
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.models.billing import PurchaseConsent, Subscription
from app.models.linking import BankConnection
from app.models.plan_event import PlanEvent
from app.models.trial_claim import TrialClaim, trial_hashes
from app.routers.linking import revoke_all
from app.rules_server.entitlements import (
    TRIAL_PLANS,
    access,
    effective_plan,
    entitlements,
    founding_left,
    is_tester,
    load_plans,
    store_entitlements,
    tester_plan,
    trial_settings,
)
from app.security.audit import AuditAction, record
from app.security.authz import owned_by
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.hashing import pseudonym
from app.security.principal import Caller, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited, session_or_ip
from app.services import consent_text, deletion, native_billing, plan_history, stripe_billing
from app.services.consent_text import CONSENT_VERSION
from app.services.security_alerts import SecurityEvent, send_alert

router = APIRouter(prefix="/api/billing", tags=["billing"], dependencies=[Depends(same_site_only)])


class PriceOut(BaseModel):
    monthly_cents: int
    yearly_cents: int


def _payment_pending(db: DbSession, user_id: uuid.UUID) -> bool:
    """A checkout paid by bank that hasn't cleared: a Stripe row still `incomplete`, recent."""
    since = datetime.now(UTC) - timedelta(days=14)
    return (
        db.scalar(
            select(Subscription.id).where(
                Subscription.user_id == user_id,
                Subscription.source == "stripe",
                or_(Subscription.status == "incomplete", Subscription.first_payment == "pending"),
                Subscription.created_at >= since,
            )
        )
        is not None
    )


class BillingOut(BaseModel):
    plan: str
    label: str
    status: str | None
    source: str | None
    interval: str | None
    renews_at: datetime | None
    ends_at: datetime | None
    cancel_at_period_end: bool
    available: bool
    has_customer: bool
    prices: dict[str, PriceOut]
    founding: dict[str, Any]
    entitlements: dict[str, Any]
    # Phase 2 (chunk 2.4): {plan: {interval: store product id}} for the native plan picker.
    store_products: dict[str, dict[str, str]]
    # A downgrade is allowed from this moment (October 17, 2026); null when it already is.
    downgrade_from: datetime | None = None
    downgrade_after_days: int = 30
    # Tester tools: true only for an admin; the plan they are testing with (null: the real one).
    tester: bool = False
    tester_plan: str | None = None
    # Free-trial lengths in days (plans.yaml `trials`): {"private": 3, "connected": 3}.
    trials: dict[str, int] = {}
    # A US bank payment is still clearing (October 24, 2026): the plan starts when it does.
    payment_pending: bool = False


class ConsentIn(BaseModel):
    """What the person read and ticked: the lines the server built for this offer (GET
    /api/billing/consent/*, or the change preview's `consent`), sent back unchanged. The route
    builds them again from the same facts and refuses any difference (409 consent_mismatch,
    October 28, 2026), so what is kept is always the server's own text."""

    version: str = Field(max_length=16)
    lines: list[str] = Field(min_length=1, max_length=10)
    agreement: str = Field(min_length=1, max_length=300)
    accepted: Literal[True]
    # The device's time zone, which the dates in the lines were written in.
    tz: str | None = Field(default=None, max_length=64)


ConsentIcon = Literal["price", "renew", "cancel", "card", "term", "refund", "unlink"]


class ConsentPointOut(BaseModel):
    text: str
    icon: ConsentIcon | None = None
    head: str | None = None


class ConsentTextOut(BaseModel):
    """What to show above the box, and exactly what to send back when it is ticked."""

    version: str
    points: list[ConsentPointOut]
    lines: list[str]
    agreement: str


def _consent_out(text: consent_text.ConsentText) -> ConsentTextOut:
    return ConsentTextOut(
        version=CONSENT_VERSION,
        points=[
            ConsentPointOut(text=p.text, icon=p.icon, head=p.head)  # type: ignore[arg-type]
            for p in text.points
        ],
        lines=text.lines,
        agreement=text.agreement,
    )


class CheckoutIn(BaseModel):
    plan: Literal["private", "connected", "founding"]
    interval: Literal["monthly", "yearly"] | None = None
    consent: ConsentIn


class ChangeTarget(BaseModel):
    plan: Literal["private", "connected"]
    interval: Literal["monthly", "yearly"]


class ChangeIn(ChangeTarget):
    # The moment the preview priced, so the charge matches what was shown (Stripe prorates
    # to the second). Ignored when older than CHANGE_PREVIEW_MAX_AGE.
    proration_date: int | None = Field(default=None, ge=0)
    consent: ConsentIn | None = None


class ChangePreviewIn(ChangeTarget):
    tz: str | None = Field(default=None, max_length=64)  # the device's, for the consent's dates


class ChangePreviewOut(BaseModel):
    kind: Literal["same", "up", "down"]
    due_now_cents: int  # charged to the card today
    credit_after_cents: int  # credit on the account after the switch, spent on the next bills
    price_cents: int
    proration_date: int
    disconnects_banks: bool  # the new plan doesn't link, so linked banks are disconnected
    consent: ConsentTextOut  # the "Change your plan" lines, sent back with the switch


class CreditOut(BaseModel):
    credit_cents: int
    refund_if_deleted_cents: int
    # Deleting keeps the current month: the date it ends (null without a live plan).
    kept_until: datetime | None = None
    # Stripe's card fee taken off a refund (plans.yaml `refunds`), for the screen to explain.
    refund_before_fee_cents: int = 0  # the unused part and credit, before Stripe's fee
    # The fee rule comes from plans.yaml `refunds` only (`_fee_rule`), never a literal here
    # (October 28, 2026).
    refund_fee_bps: int
    refund_fee_fixed_cents: int
    # How the plan was paid, so the screen names the right fee (October 24, 2026): a US bank
    # account keeps Stripe's bank fee (0.8%, at most the cap) instead of the card fee.
    refund_fee_method: Literal["card", "bank"] = "card"
    refund_bank_fee_bps: int
    refund_bank_fee_cap_cents: int


CHANGE_PREVIEW_MAX_AGE = 600


class TesterIn(BaseModel):
    plan: Literal["free", "private", "connected", "founding"] | None  # None: the real plan


class UrlOut(BaseModel):
    url: str


class NativeSyncIn(BaseModel):
    """A purchase or restore from the shell (chunk 2.4): the store's own proof."""

    platform: Literal["ios", "android"]
    jws: str | None = None  # iOS: the transaction's jwsRepresentation (StoreKit 2)
    purchase_token: str | None = None  # Android: the Play Billing purchase token


def _origin(request: Request) -> str:
    origins = get_settings().origins
    requested = request.headers.get("origin")
    if requested and requested in origins:
        return requested
    return origins[0]


def _out(db: DbSession, caller: Caller) -> BillingOut:
    plans = load_plans()
    plan, sub = effective_plan(db, caller.user.id)
    label = plans["founding"]["label"] if plan == "founding" else plans["plans"][plan]["label"]
    return BillingOut(
        plan=plan,
        label=label,
        status=sub.status if sub else None,
        source=sub.source if sub else None,
        interval=sub.interval if sub else None,
        renews_at=sub.renews_at if sub else None,
        ends_at=sub.ends_at if sub else None,
        cancel_at_period_end=bool(sub.cancel_at_period_end) if sub else False,
        # Open to buy, or already paying through Stripe (so a plan can always be managed).
        available=stripe_billing.open_for(caller.user)
        or (stripe_billing.configured() and bool(sub and sub.customer_id)),
        has_customer=bool(sub and sub.customer_id),
        prices={
            name: PriceOut(
                monthly_cents=p["price_cents"]["monthly"], yearly_cents=p["price_cents"]["yearly"]
            )
            for name, p in plans["plans"].items()
        },
        founding={
            **{
                k: plans["founding"][k]
                for k in ("one_time_cents", "term_years", "cap", "auto_renew")
            },
            "left": founding_left(db)[1],
        },
        entitlements=entitlements(db, caller.user.id),
        store_products=native_billing.store_products(),
        trials={k: int(trial_settings()[k]["days"]) for k in TRIAL_PLANS},
        payment_pending=_payment_pending(db, caller.user.id),
        downgrade_from=_downgrade_from(sub, caller),
        downgrade_after_days=int(plans["changes"]["downgrade_after_days"]),
        tester=is_tester(caller.user),
        tester_plan=tester_plan(caller.user),
    )


def _downgrade_from(sub: Subscription | None, caller: Caller) -> datetime | None:
    if sub is None or not _renewing(sub) or is_tester(caller.user):
        return None  # an admin may switch down at any time, to test it
    opens = stripe_billing.downgrade_opens_at(sub)
    if opens is not None and opens.tzinfo is None:
        opens = opens.replace(tzinfo=UTC)
    return opens if opens is not None and opens > datetime.now(UTC) else None


# Routes that call Stripe live are limited per signed-in device (October 27, 2026).
STRIPE_LIMIT = Depends(rate_limited("billing_stripe", key=session_or_ip))


@router.get("")
def billing(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> BillingOut:
    return _out(db, caller)


@router.get("/entitlements")
def get_entitlements(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> dict[str, Any]:
    return entitlements(db, caller.user.id)


def _record_consent(
    db: DbSession,
    caller: Caller,
    plan: str,
    interval: str | None,
    consent: ConsentIn,
    request: Request,
    *,
    canonical: consent_text.ConsentText,
    kind: str = "purchase",
) -> None:
    """Keep what was agreed before the payment page opens (October 14, 2026), or before a
    plan change (October 17, 2026), or before a cancellation (October 18, 2026). `canonical`
    is the text this server builds for the offer; anything else is refused, so a modified app
    cannot keep its own words under a valid version (October 28, 2026)."""
    if consent.version != CONSENT_VERSION:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="consent_outdated")
    if consent.lines != canonical.lines or consent.agreement != canonical.agreement:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="consent_mismatch")
    plans = load_plans()
    if plan == "founding":
        price = int(plans["founding"]["one_time_cents"])
    else:
        assert interval is not None
        price = int(plans["plans"][plan]["price_cents"][interval])
    ip = client_ip(request)
    db.add(
        PurchaseConsent(
            user_id=caller.user.id,
            email_hash=pseudonym(caller.user.email),
            inbox_key=stripe_billing.purchase_block_key(caller.user.email),
            plan=plan,
            interval=None if plan == "founding" else interval,
            price_cents=price,
            terms_version=CONSENT_VERSION,
            terms_text="\n".join([*canonical.lines, f"[x] {canonical.agreement}"]),
            ip_hash=pseudonym(ip) if ip else None,
            device_label=caller.session.device_label,
            agreed_at=datetime.now(UTC),
            kind=kind,
        )
    )
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PURCHASE_CONSENT,
        target=f"consent:{plan}" if kind == "purchase" else f"consent:{kind}:{plan}",
        ip=ip,
    )
    db.commit()  # kept even if Stripe is unreachable next: the person did agree


class TrialIn(BaseModel):
    plan: Literal["private", "connected"]


@router.post("/trial")
def start_trial(
    body: TrialIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> dict[str, Any]:
    """Start the free trial the person picked (owner decision, October 14, 2026): once per
    email, no card. Either plan runs 3 days (plans.yaml `trials`, since October 22, 2026)."""
    assert body.plan in TRIAL_PLANS
    if access(db, caller.user)["state"] != "choose":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="trial_not_available")
    # One trial per inbox: maya+2@ and m.aya@gmail.com count as maya@gmail.com.
    hashes = trial_hashes(caller.user.email)
    if db.scalar(select(TrialClaim.id).where(TrialClaim.email_hash.in_(hashes))):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="trial_used")
    email_hash = hashes[0]
    now = datetime.now(UTC)
    days = int(trial_settings()[body.plan]["days"])
    caller.user.trial_plan = body.plan
    caller.user.trial_ends_at = now + timedelta(days=days)
    db.add(TrialClaim(email_hash=email_hash, plan=body.plan, claimed_at=now))
    plan_history.add(db, caller.user.id, "trial_started", body.plan, at=now)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PLAN_CHANGED,
        target=f"trial:{body.plan}",
        ip=client_ip(request),
    )
    db.commit()
    return entitlements(db, caller.user.id)


@router.post("/checkout", dependencies=[STRIPE_LIMIT])
def checkout(
    body: CheckoutIn,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> UrlOut:
    if not stripe_billing.open_for(caller.user):
        # Not on sale (STACKD_BILLING_OPEN): no payment page, whatever keys are set.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="billing_unavailable")
    if body.plan != "founding" and body.interval is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="interval_required")
    if stripe_billing.is_blocked(db, caller.user):
        # A lost dispute or a fraud-warning refund (owner decision, October 24, 2026).
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="purchase_blocked")
    plan, sub = effective_plan(db, caller.user.id, tester=False)
    if plan == "founding":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_founding")
    if _renewing(sub):
        assert sub is not None
        # Never a second subscription beside a live one: plan changes go through /change.
        # Founding (one payment) can be bought once the current plan is set not to renew.
        if body.plan != "founding":
            raise HTTPException(status.HTTP_409_CONFLICT, detail="already_subscribed")
        if not sub.cancel_at_period_end:
            raise HTTPException(status.HTTP_409_CONFLICT, detail="cancel_first")
    if body.plan == "founding" and founding_left(db)[1] <= 0:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="founding_sold_out")
    now_access = access(db, caller.user)
    trial_ends_at = now_access.get("trial_ends_at") if now_access["state"] == "trial" else None
    _record_consent(
        db,
        caller,
        body.plan,
        body.interval,
        body.consent,
        request,
        canonical=consent_text.purchase(
            load_plans(),
            body.plan,
            body.interval,
            trial_ends_at=trial_ends_at,
            now=datetime.now(UTC),
            tz=consent_text.zone(body.consent.tz),
        ),
    )
    try:
        session = stripe_billing.checkout_session(
            caller.user,
            body.plan,
            None if body.plan == "founding" else body.interval,
            _origin(request),
            sub.customer_id if sub else None,
            trial_ends_at=trial_ends_at,
        )
    except stripe_billing.BillingError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code) from exc
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PLAN_CHANGED,
        target=f"checkout:{body.plan}",
        ip=client_ip(request),
    )
    db.commit()
    return UrlOut(url=str(session["url"]))


def _renewing(sub: Subscription | None) -> bool:
    """A live Stripe subscription that bills on a schedule (not Founding, not a store plan)."""
    return bool(
        sub
        and sub.source == "stripe"
        and sub.interval
        and sub.external_id
        and sub.status in ("active", "past_due")
    )


def _changeable(db: DbSession, caller: Caller) -> Subscription:
    plan, sub = effective_plan(db, caller.user.id, tester=False)
    if sub is not None and sub.source in ("apple", "google"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="manage_in_store")
    if plan == "founding":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_founding")
    if not _renewing(sub):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_subscription")
    if not stripe_billing.configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="billing_unavailable")
    assert sub is not None and sub.interval is not None
    return sub


def _price_cents(plan: str, interval: str) -> int:
    return int(load_plans()["plans"][plan]["price_cents"][interval])


def _kind(caller: Caller, sub: Subscription, target: ChangeTarget) -> str:
    assert sub.interval is not None
    kind = stripe_billing.change_kind((sub.plan, sub.interval), (target.plan, target.interval))
    if kind == "down" and _downgrade_from(sub, caller) is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="downgrade_too_soon")
    return kind


def _disconnects_banks(db: DbSession, caller: Caller, plan: str) -> bool:
    if load_plans()["plans"][plan]["bank_links_max"] != 0:
        return False
    return (
        db.scalar(select(BankConnection.id).where(BankConnection.user_id == caller.user.id))
        is not None
    )


@router.post("/change/preview", dependencies=[STRIPE_LIMIT])
def change_preview(
    body: ChangePreviewIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> ChangePreviewOut:
    """What a switch costs before it happens: today's charge for an upgrade (the new price
    less the unused part of the old), or the credit a downgrade leaves for the next bills."""
    sub = _changeable(db, caller)
    assert sub.external_id is not None
    kind = _kind(caller, sub, body)
    proration_date = int(time.time())
    due = credit = 0
    if kind != "same":
        try:
            live = stripe_billing.get_subscription(sub.external_id)
            due, credit = stripe_billing.preview_change(
                live, stripe_billing.price_for(body.plan, body.interval), proration_date
            )
        except stripe_billing.BillingError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code) from exc
    disconnects = kind == "down" and _disconnects_banks(db, caller, body.plan)
    return ChangePreviewOut(
        kind=kind,  # type: ignore[arg-type]
        due_now_cents=due,
        credit_after_cents=credit,
        price_cents=_price_cents(body.plan, body.interval),
        proration_date=proration_date,
        disconnects_banks=disconnects,
        consent=_consent_out(_change_text(sub, body, kind, due, credit, disconnects)),
    )


def _change_text(
    sub: Subscription, target: ChangeTarget, kind: str, due: int, credit: int, disconnects: bool
) -> consent_text.ConsentText:
    return consent_text.change(
        load_plans(),
        target.plan,
        target.interval,
        kind=kind,
        due_now_cents=due,
        credit_after_cents=credit,
        disconnects_banks=disconnects,
        current_plan=sub.plan,
    )


@router.post("/change", dependencies=[STRIPE_LIMIT])
def change(
    body: ChangeIn,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> BillingOut:
    """Switch plan or billing period now (owner decision, October 17, 2026). Up (Private →
    Connected, or monthly → yearly) is charged the difference; down leaves the unused part as
    credit, opens 30 days after the plan started or last changed, and disconnects linked banks
    when the new plan doesn't link. Switching also undoes a cancellation."""
    sub = _changeable(db, caller)
    assert sub.external_id is not None
    kind = _kind(caller, sub, body)
    if kind == "same":
        return _out(db, caller)
    if body.consent is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="consent_required")
    proration = body.proration_date
    if proration is not None and abs(time.time() - proration) > CHANGE_PREVIEW_MAX_AGE:
        proration = None
    try:
        live = stripe_billing.get_subscription(sub.external_id)
        # The lines are built again from what this switch charges at this proration moment,
        # so the kept text always names the amounts actually billed.
        due, credit = stripe_billing.preview_change(
            live,
            stripe_billing.price_for(body.plan, body.interval),
            proration if proration is not None else int(time.time()),
        )
    except stripe_billing.BillingError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code) from exc
    disconnects = kind == "down" and _disconnects_banks(db, caller, body.plan)
    _record_consent(
        db,
        caller,
        body.plan,
        body.interval,
        body.consent,
        request,
        canonical=_change_text(sub, body, kind, due, credit, disconnects),
        kind="change",
    )
    try:
        obj = stripe_billing.switch_price(live, body.plan, body.interval, proration_date=proration)
    except stripe_billing.BillingError as exc:
        code = (
            status.HTTP_402_PAYMENT_REQUIRED
            if exc.code == "payment_failed"
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(code, detail=exc.code) from exc
    invoice = obj.get("latest_invoice")
    plan_history.add(
        db,
        caller.user.id,
        "switched",
        body.plan,
        body.interval,
        # Charged (positive) or left as credit (negative), from the switch's own invoice.
        amount_cents=int(invoice["total"]) if isinstance(invoice, dict) else None,
    )
    sub.plan, sub.interval = body.plan, body.interval
    sub.cancel_at_period_end = False
    sub.renews_at = stripe_billing.period_end(obj) or sub.renews_at
    sub.plan_changed_at = datetime.now(UTC)
    if load_plans()["plans"][body.plan]["bank_links_max"] == 0:
        # Private never links (hard constraint 3): its banks go now, as the sheet said.
        for row in db.scalars(
            select(BankConnection).where(BankConnection.user_id == caller.user.id)
        ):
            record(
                db,
                actor_id=caller.user.id,
                action=AuditAction.BANK_DISCONNECTED,
                target=f"bank_connection:{row.id}",
                ip=client_ip(request),
            )
        revoke_all(db, caller.user.id)
    store_entitlements(db, caller.user.id)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PLAN_CHANGED,
        target=f"subscription:{sub.id}",
        ip=client_ip(request),
    )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.PLAN_CHANGED,
        device_label=caller.session.device_label,
        at=datetime.now(UTC),
    )
    return _out(db, caller)


class PlanEventOut(BaseModel):
    kind: Literal["trial_started", "subscribed", "switched", "cancelled", "resumed", "ended"]
    plan: str
    interval: str | None
    amount_cents: int | None
    until: datetime | None
    at: datetime


@router.get("/history")
def history(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> list[PlanEventOut]:
    """Plan history (owner decision, October 18, 2026): what happened to the plan, newest
    first."""
    rows = db.scalars(
        owned_by(select(PlanEvent), PlanEvent, caller.principal)
        .order_by(PlanEvent.at.desc(), PlanEvent.created_at.desc())
        .limit(100)
    )
    return [
        PlanEventOut(
            kind=r.kind,  # type: ignore[arg-type]
            plan=r.plan,
            interval=r.interval,
            amount_cents=r.amount_cents,
            until=r.until,
            at=r.at,
        )
        for r in rows
    ]


@router.get("/credit", dependencies=[STRIPE_LIMIT])
def credit(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> CreditOut:
    """Credit waiting on the account, and what deleting the account now would refund: the
    months after the current one, at the price paid, plus the credit (shown before anyone
    deletes)."""
    customers = _customers(db, caller)
    if not _may_refund(db, caller, customers):
        return CreditOut(credit_cents=0, refund_if_deleted_cents=0, **_fee_rule())
    try:
        held = sum(stripe_billing.customer_credit(c) for c in sorted(customers))
        refund, gross, kept = deletion.refund_preview(db, caller.user.id)
        method = (
            stripe_billing.payment_method_of_customer(sorted(customers)[0])
            if customers and gross
            else "card"
        )
    except stripe_billing.BillingError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code) from exc
    return CreditOut(
        credit_cents=held,
        refund_if_deleted_cents=refund,
        refund_before_fee_cents=gross,
        kept_until=kept,
        refund_fee_method=method,
        **_fee_rule(),
    )


def _customers(db: DbSession, caller: Caller) -> set[str]:
    return {
        c
        for c in db.scalars(
            select(Subscription.customer_id).where(
                Subscription.user_id == caller.user.id,
                Subscription.source == "stripe",
                Subscription.customer_id.is_not(None),
            )
        )
        if c
    }


def _may_refund(db: DbSession, caller: Caller, customers: set[str]) -> bool:
    """Deleting could pay something back only through Stripe: a customer, or a Founding row."""
    founding = any(
        s.source == "stripe" and s.interval is None
        for s in db.scalars(select(Subscription).where(Subscription.user_id == caller.user.id))
    )
    return stripe_billing.configured() and bool(customers or founding)


def _cancel_text(
    db: DbSession, caller: Caller, sub: Subscription, tz: str | None
) -> consent_text.ConsentText:
    """ "If you cancel", with what deleting instead would pay back (as GET /credit says it).
    Stripe out of reach leaves that one line out, as the app did when the credit didn't load."""
    refund = 0
    if _may_refund(db, caller, _customers(db, caller)):
        try:
            refund = deletion.refund_preview(db, caller.user.id)[0]
        except stripe_billing.BillingError:
            refund = 0
    return consent_text.cancel(
        load_plans(),
        sub.plan,
        renews_at=sub.renews_at,
        refund_if_deleted_cents=refund,
        tz=consent_text.zone(tz),
    )


@router.get("/consent/purchase")
def purchase_consent(
    plan: Literal["private", "connected", "founding"],
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
    interval: Literal["monthly", "yearly"] | None = None,
    tz: Annotated[str | None, Query(max_length=64)] = None,
) -> ConsentTextOut:
    """The "Before you subscribe" lines for one offer, as the checkout will check them."""
    if plan != "founding" and interval is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="interval_required")
    now_access = access(db, caller.user)
    return _consent_out(
        consent_text.purchase(
            load_plans(),
            plan,
            None if plan == "founding" else interval,
            trial_ends_at=now_access.get("trial_ends_at")
            if now_access["state"] == "trial"
            else None,
            now=datetime.now(UTC),
            tz=consent_text.zone(tz),
        )
    )


@router.get("/consent/cancel", dependencies=[STRIPE_LIMIT])
def cancel_consent(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
    tz: Annotated[str | None, Query(max_length=64)] = None,
) -> ConsentTextOut:
    """The "If you cancel" lines for the plan that renews now, as /cancel will check them."""
    plan, sub = effective_plan(db, caller.user.id, tester=False)
    if sub is None or plan in ("free", "founding") or sub.interval is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_subscription")
    return _consent_out(_cancel_text(db, caller, sub, tz))


def _fee_rule() -> dict[str, int]:
    rule = load_plans()["refunds"]
    return {
        "refund_fee_bps": int(rule["fee_bps"]),
        "refund_fee_fixed_cents": int(rule["fee_fixed_cents"]),
        "refund_bank_fee_bps": int(rule["bank_fee_bps"]),
        "refund_bank_fee_cap_cents": int(rule["bank_fee_cap_cents"]),
    }


@router.post("/tester", dependencies=[Depends(rate_limited("tester_plan", key=session_or_ip))])
def set_tester_plan(
    body: TesterIn,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> BillingOut:
    """Tester tools (owner decision, October 18, 2026): an admin switches their own plan for
    free, as often as they like, to test every plan; `plan: null` goes back to the real one.
    Nothing is charged and Stripe is not involved. Anyone else gets 404, as if the route were
    not there. Audited and alerted like any plan change."""
    if not is_tester(caller.user):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    caller.user.tester_plan = body.plan
    store_entitlements(db, caller.user.id)
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PLAN_CHANGED,
        target=f"tester:{body.plan or 'real'}",
        ip=client_ip(request),
    )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.PLAN_CHANGED,
        device_label=caller.session.device_label,
        at=datetime.now(UTC),
    )
    return _out(db, caller)


@router.post("/native/sync")
def native_sync(
    body: NativeSyncIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> BillingOut:
    """Attach a store purchase to the signed-in account. No step-up here by design: the signed
    transaction / verified token is stronger proof than a passkey check (the store already
    authenticated the buyer, and a stolen session cannot fabricate one); the app still asks for
    step-up before starting a purchase, like the web checkout."""
    try:
        if body.platform == "ios":
            if not body.jws:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="jws_required")
            txn = native_billing.verify_apple_jws(body.jws)
            outcome = native_billing.apply_apple_transaction(db, txn, caller_id=caller.user.id)
        else:
            if not body.purchase_token:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="token_required")
            if not native_billing.play_configured():
                raise HTTPException(
                    status.HTTP_503_SERVICE_UNAVAILABLE, detail="billing_unavailable"
                )
            info = native_billing.verify_play_subscription(body.purchase_token)
            outcome = native_billing.apply_play_subscription(
                db, body.purchase_token, info, caller_id=caller.user.id
            )
    except native_billing.BillingError as exc:
        code = (
            status.HTTP_409_CONFLICT
            if exc.code == "wrong_account"
            else status.HTTP_502_BAD_GATEWAY
            if exc.code == "play_api"
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(code, detail=exc.code) from exc
    if outcome == "synced":
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.PLAN_CHANGED,
            target=f"native:{body.platform}",
            ip=client_ip(request),
        )
    db.commit()
    return _out(db, caller)


@router.post("/portal", dependencies=[STRIPE_LIMIT])
def portal(
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> UrlOut:
    if not stripe_billing.configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="billing_unavailable")
    _, sub = effective_plan(db, caller.user.id, tester=False)
    if sub is None or not sub.customer_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_customer")
    try:
        session = stripe_billing.portal_session(sub.customer_id, _origin(request))
    except stripe_billing.BillingError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code) from exc
    return UrlOut(url=str(session["url"]))


class CancelIn(BaseModel):
    consent: ConsentIn


def _change_renewal(
    db: DbSession,
    caller: Caller,
    request: Request,
    *,
    cancel: bool,
    consent: ConsentIn | None = None,
) -> BillingOut:
    plan, sub = effective_plan(db, caller.user.id, tester=False)
    if sub is None or plan == "free":
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_subscription")
    if sub.source in ("apple", "google"):
        raise HTTPException(status.HTTP_409_CONFLICT, detail="manage_in_store")
    if plan == "founding" or sub.interval is None:
        # One payment for a fixed term: it never renews, so there is nothing to cancel.
        raise HTTPException(status.HTTP_409_CONFLICT, detail="does_not_renew")
    if sub.status == "canceled":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="already_ended")
    if bool(sub.cancel_at_period_end) == cancel:
        return _out(db, caller)  # already in the state asked for
    if not stripe_billing.configured() or not sub.external_id:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="billing_unavailable")
    if consent is not None:
        # Ticked "I have read and understood" (owner decision, October 18, 2026): kept like a
        # purchase, before Stripe is asked.
        _record_consent(
            db,
            caller,
            plan,
            sub.interval,
            consent,
            request,
            canonical=_cancel_text(db, caller, sub, consent.tz),
            kind="cancel",
        )
    try:
        obj = stripe_billing.set_cancel_at_period_end(sub.external_id, cancel)
    except stripe_billing.BillingError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code) from exc
    sub.cancel_at_period_end = bool(obj.get("cancel_at_period_end", cancel))
    sub.renews_at = stripe_billing.period_end(obj) or sub.renews_at
    plan_history.add(
        db,
        caller.user.id,
        "cancelled" if cancel else "resumed",
        plan,
        sub.interval,
        until=sub.renews_at if cancel else None,
    )
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.PLAN_CHANGED,
        target=f"subscription:{sub.id}",
        ip=client_ip(request),
    )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.PLAN_CHANGED,
        device_label=caller.session.device_label,
        at=datetime.now(UTC),
    )
    return _out(db, caller)


@router.post("/cancel", dependencies=[STRIPE_LIMIT])
def cancel(
    body: CancelIn,
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> BillingOut:
    """Stop renewal. The plan stays on until the end of the period already paid for (a month
    from the last monthly charge, a year from the last yearly one), then the account is Free;
    nothing is deleted. Needs the ticked consent, recorded like a purchase's."""
    return _change_renewal(db, caller, request, cancel=True, consent=body.consent)


@router.post("/resume", dependencies=[STRIPE_LIMIT])
def resume(
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> BillingOut:
    """Undo a cancellation before the period ends: renewal continues as before."""
    return _change_renewal(db, caller, request, cancel=False)
