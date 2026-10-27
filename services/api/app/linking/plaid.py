"""Plaid, as plain REST through `outbound_client` (docs/security/linking.md).

Only Transactions and Liabilities are requested; nothing that reads account numbers or
identity, nothing that moves money. Linking runs on Plaid's Hosted Link page, so the app never
loads Plaid's JavaScript. Provider categories, balances and account names are never stored.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from typing import Any

import httpx2

from app.config import get_settings
from app.security.outbound import outbound_client

log = logging.getLogger("stackd.plaid")

HOSTS = {"sandbox": "https://sandbox.plaid.com", "production": "https://production.plaid.com"}
PRODUCTS = ["transactions"]
OPTIONAL_PRODUCTS = ["liabilities"]  # cards: statement balance, due date, minimum, limit, APR
DAYS_REQUESTED = 365  # proposed: a year of history for recurring detection and seasonal
LINK_LIFETIME_SECONDS = 1800
SYNC_PAGE_SIZE = 500  # Plaid's maximum per /transactions/sync call
SYNC_MAX_PAGES = 4  # per request; the device asks again while has_more is true
transport_override: httpx2.BaseTransport | None = None


class LinkError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ItemAdd:
    public_token: str
    institution_name: str
    institution_id: str | None  # Plaid's id for the bank, to spot a second link to it


def configured() -> bool:
    s = get_settings()
    return bool(
        s.plaid_client_id
        and s.plaid_secret is not None
        and s.plaid_secret.get_secret_value().strip()
        and s.link_token_key is not None
        and s.link_token_key.get_secret_value().strip()
    )


def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    s = get_settings()
    if not configured():
        raise LinkError("linking_unavailable")
    assert s.plaid_secret is not None and s.plaid_client_id is not None
    headers = {
        "PLAID-CLIENT-ID": s.plaid_client_id,
        "PLAID-SECRET": s.plaid_secret.get_secret_value(),
        "Plaid-Version": "2020-09-14",
    }
    kwargs: dict[str, Any] = {"transport": transport_override} if transport_override else {}
    try:
        with outbound_client(**kwargs) as client:
            response = client.post(f"{HOSTS[s.plaid_env]}{path}", json=body, headers=headers)
    except httpx2.HTTPError as exc:
        log.warning("plaid %s unreachable: %s", path, type(exc).__name__)
        raise LinkError("provider_unreachable") from exc
    try:
        data = response.json()
    except ValueError as exc:
        log.warning("plaid %s: HTTP %s, not JSON", path, response.status_code)
        raise LinkError("provider_error") from exc
    if response.status_code >= 400:
        # Plaid's error_code is a stable identifier (e.g. ITEM_LOGIN_REQUIRED), never user data.
        # The request_id is what Plaid support asks for. Nothing else from the body is logged:
        # error messages can name the institution or echo request fields.
        log.warning(
            "plaid %s failed: HTTP %s error_type=%s error_code=%s request_id=%s",
            path,
            response.status_code,
            _ident(data.get("error_type")),
            _ident(data.get("error_code")),
            _ident(data.get("request_id")),
        )
        raise LinkError(str(data.get("error_code") or "provider_error").lower())
    return data


def _ident(value: Any) -> str:
    """An identifier from Plaid's error body, kept to safe characters and length for a log line."""
    text = str(value or "-")[:64]
    return text if all(c.isalnum() or c in "_-" for c in text) else "?"


def create_link_token(
    client_user_id: str, completion_redirect_uri: str, *, access_token: str | None = None
) -> dict[str, str]:
    """A link token and the Hosted Link URL the browser is sent to. With `access_token` it is
    Plaid's update mode: the user signs in to the same bank again, no new item, no products."""
    settings = get_settings()
    body: dict[str, Any] = {
        "client_name": settings.rp_name,
        "language": "en",
        "country_codes": ["US"],
        "user": {"client_user_id": client_user_id},
        "hosted_link": {
            "completion_redirect_uri": completion_redirect_uri,
            "url_lifetime_seconds": LINK_LIFETIME_SECONDS,
        },
    }
    if access_token:
        body["access_token"] = access_token
    else:
        body["products"] = PRODUCTS
        body["optional_products"] = OPTIONAL_PRODUCTS
        body["transactions"] = {"days_requested": DAYS_REQUESTED}
    if settings.plaid_webhook_url:
        body["webhook"] = settings.plaid_webhook_url
    data = _post("/link/token/create", body)
    if not data.get("link_token") or not data.get("hosted_link_url"):
        raise LinkError("provider_error")
    return {"link_token": data["link_token"], "hosted_link_url": data["hosted_link_url"]}


def link_results(link_token: str) -> list[ItemAdd]:
    """What the user linked in the session; empty when they left without linking."""
    data = _post("/link/token/get", {"link_token": link_token})
    adds: list[ItemAdd] = []
    for session in data.get("link_sessions") or []:
        results = session.get("results") or {}
        for item in results.get("item_add_results") or []:
            token = item.get("public_token")
            if token:
                institution = item.get("institution") or {}
                name = str(institution.get("name") or "Your bank")[:120]
                ins_id = institution.get("institution_id")
                adds.append(
                    ItemAdd(
                        public_token=token,
                        institution_name=name,
                        institution_id=str(ins_id)[:40] if ins_id else None,
                    )
                )
    return adds


def exchange(public_token: str) -> tuple[str, str]:
    data = _post("/item/public_token/exchange", {"public_token": public_token})
    if not data.get("access_token") or not data.get("item_id"):
        raise LinkError("provider_error")
    return data["access_token"], data["item_id"]


def accounts(access_token: str) -> list[dict[str, str | None]]:
    """The accounts the user shared: id, name, last four, type. Balances are dropped here."""
    data = _post("/accounts/get", {"access_token": access_token})
    return [
        {
            "account_id": str(a["account_id"]),
            "name": str(a.get("official_name") or a.get("name") or "Account")[:80],
            "mask": (str(a["mask"])[-4:] if a.get("mask") else None),
            "type": str(a.get("type") or "other"),
            "subtype": (str(a["subtype"]) if a.get("subtype") else None),
        }
        for a in data.get("accounts") or []
        if a.get("account_id")
    ]


def remove_item(access_token: str) -> None:
    """Revoke the access token at Plaid. Already gone counts as done."""
    try:
        _post("/item/remove", {"access_token": access_token})
    except LinkError as exc:
        if exc.code not in ("item_not_found", "invalid_access_token"):
            raise


@dataclass
class SyncResult:
    """One pull, already reduced to what the device needs. Nothing here is stored."""

    added: list[dict[str, Any]] = field(default_factory=list)
    modified: list[dict[str, Any]] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    balances: list[dict[str, Any]] = field(default_factory=list)
    next_cursor: str = ""
    has_more: bool = False


def _cents(value: Any) -> int | None:
    """Plaid amounts are JSON numbers in dollars: cents through Decimal, half-even."""
    try:
        return int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_EVEN))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _txn(t: dict[str, Any]) -> dict[str, Any] | None:
    """Keep only the fields the device's rules read. Provider categories, locations, payment
    channels, counterparties and logos are dropped here (results stay deterministic)."""
    cents = _cents(t.get("amount"))
    if cents is None or not t.get("transaction_id") or not t.get("account_id") or not t.get("date"):
        return None
    return {
        "transaction_id": str(t["transaction_id"]),
        "account_id": str(t["account_id"]),
        "date": str(t["date"])[:10],
        # Plaid: positive = money leaving the account (a purchase, a card charge).
        "direction": "out" if cents > 0 else "in",
        "amount_cents": abs(cents),
        "description": str(t.get("merchant_name") or t.get("name") or "")[:140],
        "pending": bool(t.get("pending")),
        "pending_transaction_id": (
            str(t["pending_transaction_id"]) if t.get("pending_transaction_id") else None
        ),
    }


def _balance(a: dict[str, Any]) -> dict[str, Any] | None:
    balances = a.get("balances") or {}
    cents = _cents(balances.get("current"))
    if cents is None or not a.get("account_id"):
        return None
    return {
        "account_id": str(a["account_id"]),
        "current_cents": cents,
        "type": str(a.get("type") or "other"),
    }


def transactions_sync(access_token: str, cursor: str | None) -> SyncResult:
    """Pull changes since the device's cursor, up to SYNC_MAX_PAGES pages. If the item changed
    mid-pagination, Plaid asks us to restart from the same cursor; we do, once."""
    for attempt in range(2):
        out = SyncResult(next_cursor=cursor or "")
        try:
            for _ in range(SYNC_MAX_PAGES):
                body: dict[str, Any] = {"access_token": access_token, "count": SYNC_PAGE_SIZE}
                if out.next_cursor:
                    body["cursor"] = out.next_cursor
                data = _post("/transactions/sync", body)
                out.added += [x for x in map(_txn, data.get("added") or []) if x]
                out.modified += [x for x in map(_txn, data.get("modified") or []) if x]
                out.removed += [
                    str(r["transaction_id"])
                    for r in data.get("removed") or []
                    if r.get("transaction_id")
                ]
                if data.get("accounts"):
                    out.balances = [x for x in map(_balance, data["accounts"]) if x]
                out.next_cursor = str(data.get("next_cursor") or out.next_cursor)
                out.has_more = bool(data.get("has_more"))
                if not out.has_more:
                    break
            return out
        except LinkError as exc:
            if exc.code == "transactions_sync_mutation_during_pagination" and attempt == 0:
                continue
            raise
    raise LinkError("provider_error")


def _bps(value: Any) -> int | None:
    """An APR percentage (24.99) to basis points (2499), half-even."""
    try:
        return int((Decimal(str(value)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_EVEN))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _day(value: Any) -> str | None:
    return str(value)[:10] if value else None


def _card(c: dict[str, Any], limits: dict[str, int | None]) -> dict[str, Any] | None:
    """One credit card's statement facts. The purchase APR when the issuer lists several."""
    if not c.get("account_id"):
        return None
    aprs = c.get("aprs") or []
    purchase = next((a for a in aprs if a.get("apr_type") == "purchase_apr"), None)
    chosen = purchase or (aprs[0] if aprs else None)
    return {
        "account_id": str(c["account_id"]),
        "statement_balance_cents": _cents(c.get("last_statement_balance")),
        "statement_date": _day(c.get("last_statement_issue_date")),
        "due_date": _day(c.get("next_payment_due_date")),
        "minimum_cents": _cents(c.get("minimum_payment_amount")),
        "last_payment_cents": _cents(c.get("last_payment_amount")),
        "last_payment_date": _day(c.get("last_payment_date")),
        "limit_cents": limits.get(str(c["account_id"])),
        "apr_bps": _bps(chosen.get("apr_percentage")) if chosen else None,
        "is_overdue": bool(c.get("is_overdue")),
    }


# The item has no card data (no card shared, or Liabilities not on this item): an empty answer.
NO_CARD_DATA = {"products_not_supported", "no_liability_accounts", "additional_consent_required"}


def card_details(access_token: str) -> list[dict[str, Any]]:
    """The Liabilities product, reduced to what a card screen shows (chunk 3.5). Pass-through:
    the caller returns it to the device and keeps nothing."""
    try:
        data = _post("/liabilities/get", {"access_token": access_token})
    except LinkError as exc:
        if exc.code in NO_CARD_DATA:
            return []
        raise
    limits = {
        str(a.get("account_id")): _cents((a.get("balances") or {}).get("limit"))
        for a in data.get("accounts") or []
        if a.get("account_id")
    }
    credit = (data.get("liabilities") or {}).get("credit") or []
    return [x for x in (_card(c, limits) for c in credit) if x]


def webhook_key(key_id: str) -> dict[str, Any]:
    """The public JWK Plaid signs webhooks with (ES256), by its key id."""
    data = _post("/webhook_verification_key/get", {"key_id": key_id})
    key = data.get("key") or {}
    if key.get("kty") != "EC" or key.get("crv") != "P-256" or not key.get("x") or not key.get("y"):
        raise LinkError("provider_error")
    return key
