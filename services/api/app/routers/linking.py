"""Read-only bank and card linking (Phase 3, chunk 3.2; docs/security/linking.md).

- GET /api/linking: whether linking is offered, the plan's cap, the user's connections
- POST /api/linking/start: step-up, plan cap, then a Hosted Link URL to send the browser to
- POST /api/linking/finish: the session's outcome; tokens exchanged, sealed and stored, and
  the shared accounts (name, last four, type) returned to the device and not kept
- POST /api/linking/{id}/sync: the transactions and balances since the device's cursor,
  passed through and not kept (chunk 3.3)
- POST /api/linking/{id}/cards: each shared credit card's statement balance, statement and due
  dates, minimum, last payment, limit and APR, passed through and not kept (chunk 3.5)
- POST /api/linking/{id}/relink: a Hosted Link trip in update mode, when the bank asks the
  user to sign in again (chunk 3.4); finished through /finish like a new link
- DELETE /api/linking/{id}: revoke the token at the provider, then delete the connection; if the
  provider is down the connection is hidden at once and the revoke retried (chunk 3.4)
"""

from __future__ import annotations

import hashlib
import hmac
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.linking import plaid, token_vault
from app.models.linking import BankConnection, LinkSession
from app.models.user import User
from app.rules_server.entitlements import check_limit, entitlements
from app.security.audit import AuditAction, record
from app.security.authz import get_owned, owned_by
from app.security.client import client_ip
from app.security.csrf import same_site_only
from app.security.principal import Caller, require_step_up, require_unlocked
from app.security.rate_limit import rate_limited, session_or_ip
from app.services import ops_alerts
from app.services.security_alerts import SecurityEvent, send_alert

router = APIRouter(prefix="/api/linking", tags=["linking"], dependencies=[Depends(same_site_only)])


class ConnectionOut(BaseModel):
    id: uuid.UUID
    institution_name: str
    created_at: datetime
    status: str = "ok"  # ok | login_required | revoked
    updates_available: bool = False  # the provider's webhook says there is something to pull
    last_synced_at: datetime | None = None


class SyncIn(BaseModel):
    cursor: str | None = Field(default=None, max_length=2048)


class SyncTxn(BaseModel):
    transaction_id: str
    account_id: str
    date: str
    direction: str  # "in" | "out"
    amount_cents: int
    description: str
    pending: bool
    pending_transaction_id: str | None


class SyncBalance(BaseModel):
    account_id: str
    current_cents: int
    type: str


class SyncOut(BaseModel):
    added: list[SyncTxn]
    modified: list[SyncTxn]
    removed: list[str]
    balances: list[SyncBalance]
    next_cursor: str
    has_more: bool


class CardDetail(BaseModel):
    account_id: str
    statement_balance_cents: int | None
    statement_date: str | None
    due_date: str | None
    minimum_cents: int | None
    last_payment_cents: int | None
    last_payment_date: str | None
    limit_cents: int | None
    apr_bps: int | None
    is_overdue: bool


class CardsOut(BaseModel):
    cards: list[CardDetail]


class LinkingOut(BaseModel):
    available: bool  # the server is configured for a provider
    max_connections: int | None  # the plan's cap; 0 = not on this plan, null = unlimited
    connections: list[ConnectionOut]


class StartOut(BaseModel):
    session_id: uuid.UUID
    url: str


class FinishIn(BaseModel):
    session_id: uuid.UUID


class LinkedAccount(BaseModel):
    account_id: str
    name: str
    mask: str | None
    type: str
    subtype: str | None


class LinkedConnection(ConnectionOut):
    accounts: list[LinkedAccount]


class FinishOut(BaseModel):
    status: str  # "linked" | "cancelled" | "already_linked"
    connections: list[LinkedConnection]
    # Banks this user already has a working connection to. Plaid's guidance: such a link is
    # never exchanged, so no second item (and no second monthly fee) exists; the user is
    # pointed at "Sign in again" on the one they have.
    already_linked: list[str] = []


def _origin(request: Request) -> str:
    origins = get_settings().origins
    requested = request.headers.get("origin")
    return requested if requested and requested in origins else origins[0]


def _client_user_id(user_id: uuid.UUID) -> str:
    """A stable pseudonym for the provider: never the email or our row id."""
    secret = get_settings().secret_key.get_secret_value().encode()
    return hmac.new(secret, f"link-user:{user_id}".encode(), hashlib.sha256).hexdigest()[:32]


LIVE = BankConnection.status != "revoke_pending"


def _count(db: DbSession, caller: Caller) -> int:
    stmt = owned_by(
        select(func.count()).select_from(BankConnection), BankConnection, caller.principal
    ).where(LIVE)
    return int(db.scalar(stmt) or 0)


def _live(db: DbSession, connection_id: uuid.UUID, caller: Caller) -> BankConnection:
    row = get_owned(db, BankConnection, connection_id, caller.principal)
    if row.status == "revoke_pending":  # already disconnected, as far as the user is concerned
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    return row


def _require_linking(db: DbSession, caller: Caller) -> None:
    """Reading a bank needs a plan that links (October 24, 2026): once a Connected plan or
    trial ends, its connections are kept (resubscribing picks up where it left off) but not
    read, so neither the provider's data nor its per-connection bill runs on for free."""
    if entitlements(db, caller.user.id).get("bank_links_max") == 0:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_required")


def _bad_gateway(exc: plaid.LinkError) -> HTTPException:
    if exc.code == "linking_unavailable":
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="linking_unavailable")
    return HTTPException(status.HTTP_502_BAD_GATEWAY, detail=exc.code)


@router.get("")
def linking_status(
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> LinkingOut:
    rows = db.scalars(
        owned_by(select(BankConnection), BankConnection, caller.principal)
        .where(LIVE)
        .order_by(BankConnection.created_at, BankConnection.id)
    ).all()
    # The app asks for this when it opens (LinkedSync), so it is what "opening the app" means
    # for the 60-day dormancy rule (chunk 3.4).
    now = datetime.now(UTC)
    for r in rows:
        r.last_used_at = now
    db.commit()
    cap = entitlements(db, caller.user.id).get("bank_links_max")
    return LinkingOut(
        available=plaid.configured(),
        max_connections=None if cap is None else int(cap),
        connections=[
            ConnectionOut(
                id=r.id,
                institution_name=r.institution_name,
                created_at=r.created_at,
                status=r.status,
                updates_available=r.updates_available_at is not None,
                last_synced_at=r.last_synced_at,
            )
            for r in rows
        ],
    )


@router.post("/start", dependencies=[Depends(rate_limited("link_start"))])
def start(
    caller: Annotated[Caller, Depends(require_step_up)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> StartOut:
    if not plaid.configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="linking_unavailable")
    check_limit(db, caller.user.id, "bank_links_max", _count(db, caller))
    session_id = uuid.uuid4()
    try:
        link = plaid.create_link_token(
            _client_user_id(caller.user.id),
            f"{_origin(request)}/me/linking/done?session={session_id}",
        )
    except plaid.LinkError as exc:
        raise _bad_gateway(exc) from exc
    db.add(
        LinkSession(
            id=session_id,
            user_id=caller.user.id,
            link_token_encrypted=token_vault.seal(link["link_token"]),
            expires_at=datetime.now(UTC) + timedelta(hours=6),
        )
    )
    db.commit()
    return StartOut(session_id=session_id, url=link["hosted_link_url"])


@router.post("/{connection_id}/relink", dependencies=[Depends(rate_limited("link_start"))])
def relink(
    connection_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> StartOut:
    """Plaid update mode for a connection whose bank wants the user to sign in again. No
    step-up: it restores what the user already allowed and reads nothing new."""
    _require_linking(db, caller)
    row = _live(db, connection_id, caller)
    session_id = uuid.uuid4()
    try:
        link = plaid.create_link_token(
            _client_user_id(caller.user.id),
            f"{_origin(request)}/me/linking/done?session={session_id}",
            access_token=token_vault.open_(row.access_token_encrypted),
        )
    except plaid.LinkError as exc:
        raise _bad_gateway(exc) from exc
    db.add(
        LinkSession(
            id=session_id,
            user_id=caller.user.id,
            connection_id=row.id,
            link_token_encrypted=token_vault.seal(link["link_token"]),
            expires_at=datetime.now(UTC) + timedelta(hours=6),
        )
    )
    db.commit()
    return StartOut(session_id=session_id, url=link["hosted_link_url"])


def _finish_relink(db: DbSession, link_session: LinkSession, now: datetime) -> FinishOut:
    """After update mode: if the provider reads the item again, it is repaired."""
    row = db.get(BankConnection, link_session.connection_id)
    link_session.finished_at = now
    if row is None or row.status == "revoke_pending":
        db.commit()
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    try:
        shared = plaid.accounts(token_vault.open_(row.access_token_encrypted))
    except plaid.LinkError as exc:
        db.commit()
        if exc.code in ("item_login_required", "pending_expiration"):
            return FinishOut(status="cancelled", connections=[])
        raise _bad_gateway(exc) from exc
    row.status = "ok"
    row.last_used_at = now
    db.commit()
    return FinishOut(
        status="linked",
        connections=[
            LinkedConnection(
                id=row.id,
                institution_name=row.institution_name,
                created_at=row.created_at,
                accounts=[LinkedAccount(**a) for a in shared],
            )
        ],
    )


@router.post("/finish", dependencies=[Depends(rate_limited("bank_link_finish", key=session_or_ip))])
def finish(
    body: FinishIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> FinishOut:
    # One finish at a time per person (October 28, 2026): the person's row, then the session,
    # both held to the commit, so a second finish of the same session sees it used, and two
    # sessions count the plan's places one after the other.
    db.execute(select(User.id).where(User.id == caller.user.id).with_for_update())
    link_session = db.scalar(
        owned_by(select(LinkSession), LinkSession, caller.principal)
        .where(LinkSession.id == body.session_id)
        .with_for_update()
    )
    if link_session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="not_found")
    now = datetime.now(UTC)
    if link_session.finished_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="session_used")
    if link_session.expires_at < now:
        raise HTTPException(status.HTTP_410_GONE, detail="session_expired")
    if link_session.connection_id is not None:
        return _finish_relink(db, link_session, now)
    try:
        adds = plaid.link_results(token_vault.open_(link_session.link_token_encrypted))
    except plaid.LinkError as exc:
        raise _bad_gateway(exc) from exc
    link_session.finished_at = now
    if not adds:
        db.commit()
        return FinishOut(status="cancelled", connections=[])

    cap = entitlements(db, caller.user.id).get("bank_links_max")
    room = None if cap is None else max(0, int(cap) - _count(db, caller))
    # Banks with a working connection already (a disconnected or bank-revoked one may be
    # linked afresh). Plaid bills an item while an access token exists, so a duplicate or an
    # over-cap link is never exchanged: its public token simply expires unused.
    have = set(
        db.scalars(
            owned_by(select(BankConnection.institution_id), BankConnection, caller.principal).where(
                BankConnection.status.in_(("ok", "login_required")),
                BankConnection.institution_id.is_not(None),
            )
        )
    )
    linked: list[LinkedConnection] = []
    already: list[str] = []
    over_cap = False
    for add in adds:
        if add.institution_id is not None and add.institution_id in have:
            already.append(add.institution_name)
            continue
        if room is not None and len(linked) >= room:
            over_cap = True
            continue
        try:
            access_token, item_id = plaid.exchange(add.public_token)
        except plaid.LinkError as exc:
            db.commit()
            raise _bad_gateway(exc) from exc
        row = db.scalar(select(BankConnection).where(BankConnection.item_id == item_id))
        if row is not None and row.user_id != caller.user.id:
            # Someone else's item: never adopted. Its removal failing must not fail the finish;
            # that account's row still tracks the item, so its own revoke covers this token too.
            try:
                plaid.remove_item(access_token)
            except plaid.LinkError as exc:
                ops_alerts.report("plaid_remove_item", "linking.finish", exc)
            continue
        if row is None:
            row = BankConnection(
                user_id=caller.user.id,
                provider="plaid",
                item_id=item_id,
                institution_name=add.institution_name,
                institution_id=add.institution_id,
                last_used_at=now,
                access_token_encrypted="",
                key_id="",
            )
            db.add(row)
        # Sealed before anything else can fail: the exchanged token is live at Plaid from this
        # moment, so it is tracked from this moment (linking.md: a live token is never forgotten).
        row.access_token_encrypted = token_vault.seal(access_token)
        row.key_id = token_vault.key_id()
        db.flush()
        try:
            shared = plaid.accounts(access_token)
        except plaid.LinkError as exc:
            # The row holds the sealed token: hand it to the revoke job instead of losing it.
            row.status = "revoke_pending"
            db.commit()
            raise _bad_gateway(exc) from exc
        if add.institution_id is not None:
            have.add(add.institution_id)
        record(
            db,
            actor_id=caller.user.id,
            action=AuditAction.BANK_CONNECTED,
            target=f"bank_connection:{row.id}",
            ip=client_ip(request),
        )
        linked.append(
            LinkedConnection(
                id=row.id,
                institution_name=row.institution_name,
                created_at=row.created_at,
                accounts=[LinkedAccount(**a) for a in shared],
            )
        )
    db.commit()
    if linked:
        send_alert(
            caller.user.email,
            SecurityEvent.BANK_CONNECTED,
            device_label=caller.session.device_label,
            at=now,
        )
    if over_cap and not linked and not already:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="plan_limit")
    if not linked and already:
        return FinishOut(status="already_linked", connections=[], already_linked=already)
    return FinishOut(status="linked", connections=linked, already_linked=already)


@router.post("/{connection_id}/sync", dependencies=[Depends(rate_limited("link_sync"))])
def sync(
    connection_id: uuid.UUID,
    body: SyncIn,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> SyncOut:
    """Pass-through: the provider's changes go to the device and nowhere else. Nothing about
    the transactions is logged or stored; the connection only notes when it was last read."""
    _require_linking(db, caller)
    row = _live(db, connection_id, caller)
    if row.status == "revoked":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="connection_revoked")
    try:
        result = plaid.transactions_sync(token_vault.open_(row.access_token_encrypted), body.cursor)
    except plaid.LinkError as exc:
        if exc.code in ("item_login_required", "pending_expiration"):
            row.status = "login_required"
            db.commit()
            raise HTTPException(status.HTTP_409_CONFLICT, detail="login_required") from exc
        raise _bad_gateway(exc) from exc
    now = datetime.now(UTC)
    row.last_used_at = now
    row.last_synced_at = now
    if not result.has_more:
        row.updates_available_at = None
    if row.status == "login_required":
        row.status = "ok"
    db.commit()
    return SyncOut(
        added=[SyncTxn(**t) for t in result.added],
        modified=[SyncTxn(**t) for t in result.modified],
        removed=result.removed,
        balances=[SyncBalance(**b) for b in result.balances],
        next_cursor=result.next_cursor,
        has_more=result.has_more,
    )


@router.post("/{connection_id}/cards", dependencies=[Depends(rate_limited("link_sync"))])
def cards(
    connection_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    db: Annotated[DbSession, Depends(get_db)],
) -> CardsOut:
    """Pass-through, like sync: the card facts go to the device and nowhere else."""
    _require_linking(db, caller)
    row = _live(db, connection_id, caller)
    if row.status == "revoked":
        raise HTTPException(status.HTTP_409_CONFLICT, detail="connection_revoked")
    try:
        found = plaid.card_details(token_vault.open_(row.access_token_encrypted))
    except plaid.LinkError as exc:
        if exc.code in ("item_login_required", "pending_expiration"):
            row.status = "login_required"
            db.commit()
            raise HTTPException(status.HTTP_409_CONFLICT, detail="login_required") from exc
        raise _bad_gateway(exc) from exc
    row.last_used_at = datetime.now(UTC)
    db.commit()
    return CardsOut(cards=[CardDetail(**c) for c in found])


def revoke(db: DbSession, row: BankConnection) -> None:
    """Revoke at the provider, then delete our copy. Raises LinkError if the provider fails."""
    plaid.remove_item(token_vault.open_(row.access_token_encrypted))
    db.delete(row)


@router.delete(
    "/{connection_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(rate_limited("bank_disconnect", key=session_or_ip))],
)
def disconnect(
    connection_id: uuid.UUID,
    caller: Annotated[Caller, Depends(require_unlocked)],
    request: Request,
    db: Annotated[DbSession, Depends(get_db)],
) -> None:
    """No step-up: leaving is never harder than joining (docs/security/linking.md). If the
    provider can't be reached, the connection is hidden now and `stackd-api revoke-links`
    keeps trying, so the user is never stuck with a connection they asked to drop."""
    row = _live(db, connection_id, caller)
    try:
        revoke(db, row)
    except (plaid.LinkError, token_vault.VaultError):
        row.status = "revoke_pending"
    record(
        db,
        actor_id=caller.user.id,
        action=AuditAction.BANK_DISCONNECTED,
        target=f"bank_connection:{connection_id}",
        ip=client_ip(request),
    )
    db.commit()
    send_alert(
        caller.user.email,
        SecurityEvent.BANK_DISCONNECTED,
        device_label=caller.session.device_label,
        at=datetime.now(UTC),
    )


def revoke_all(db: DbSession, user_id: uuid.UUID) -> None:
    """Account deletion: revoke every connection. One the provider refuses is marked
    revoke_pending and retried by `stackd-api revoke-links`, never forgotten with a live token
    at the provider; the purge waits for it (deletion.purge_due)."""
    for row in db.scalars(select(BankConnection).where(BankConnection.user_id == user_id)):
        try:
            revoke(db, row)
        except (plaid.LinkError, token_vault.VaultError):
            row.status = "revoke_pending"
    db.flush()
