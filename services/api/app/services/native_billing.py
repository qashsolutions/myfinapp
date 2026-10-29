"""Apple and Google subscriptions into the same entitlement record (Phase 2, chunk 2.4).

The device buys through StoreKit 2 / Play Billing (`apps/web/src/native/purchases.ts` and the
shell's StackdPurchases plugin) and syncs the proof to `POST /api/billing/native/sync`: the
transaction's signed JWS on iOS, the purchase token on Android. The server trusts only what it
verifies itself: a JWS must chain to the pinned Apple root (bundled; fingerprint checked at
review time), and a purchase token is looked up at the Play Developer API with our service
account. The store webhooks follow the same rule: Apple's signedPayload is chain-verified, and
Google's RTDN is only a hint whose token is re-verified against the API, so its transport
authenticity never matters.

One `subscriptions` row per store subscription (external_id `apple:<original transaction id>`
or `google:<token hash>`), and the newest live row wins across web and native
(`entitlements.effective_plan`), exactly like Stripe. A row is linked to a user by the account
token our app sets at purchase (`appAccountToken` / `obfuscatedExternalAccountId`, both the
user id) or by the signed-in caller on sync; a proof that belongs to another account is
refused there.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

import httpx2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from pydantic import StringConstraints

from app.config import get_settings
from app.models.billing import BillingEvent, Subscription
from app.models.user import User
from app.rules_server.entitlements import load_plans, store_entitlements
from app.security.outbound import outbound_client
from app.services.google_auth import access_token
from app.services.stripe_billing import BillingError

APPLE_ROOT_PATH = Path(__file__).with_name("apple_root_ca_g3.pem")
PLAY_API = "https://androidpublisher.googleapis.com"
PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher"  # net-allow: a JWT scope claim
transport_override: httpx2.BaseTransport | None = None  # tests install a MockTransport here


def _client() -> httpx2.Client:
    kwargs: dict[str, Any] = {}
    if transport_override is not None:
        kwargs["transport"] = transport_override
    return outbound_client(**kwargs)


# --- the product map (plans.yaml is the one place plans live) ---------------------------------


def product_for(product_id: str) -> tuple[str, str] | None:
    entry = (load_plans().get("store_products") or {}).get(product_id)
    if not entry:
        return None
    return str(entry["plan"]), str(entry["interval"])


def store_products() -> dict[str, dict[str, str]]:
    """{plan: {interval: product id}} for the app's plan picker."""
    out: dict[str, dict[str, str]] = {}
    for product_id, entry in (load_plans().get("store_products") or {}).items():
        out.setdefault(str(entry["plan"]), {})[str(entry["interval"])] = str(product_id)
    return out


# --- Apple: signed JWS, chain pinned to Apple's root ------------------------------------------


# Apple's markers (as Apple's own App Store Server Library checks them): the leaf that signs App
# Store JWS carries 1.2.840.113635.100.6.11.1 and its issuer, the Worldwide Developer Relations
# intermediate, 1.2.840.113635.100.6.2.1. Without them any certificate Apple's root vouches for
# (a developer's own, say) could sign a fake purchase (October 29, 2026).
APPLE_LEAF_OID = x509.ObjectIdentifier("1.2.840.113635.100.6.11.1")
APPLE_INTERMEDIATE_OID = x509.ObjectIdentifier("1.2.840.113635.100.6.2.1")


def _has_marker(cert: x509.Certificate, oid: x509.ObjectIdentifier) -> bool:
    try:
        cert.extensions.get_extension_for_oid(oid)
    except x509.ExtensionNotFound:
        return False
    return True


def _apple_roots() -> list[x509.Certificate]:
    pem = get_settings().apple_root_ca
    data = pem.encode() if pem else APPLE_ROOT_PATH.read_bytes()
    return x509.load_pem_x509_certificates(data)


def _verify_cert_signature(cert: x509.Certificate, issuer_key: Any) -> None:
    if isinstance(issuer_key, ec.EllipticCurvePublicKey):
        issuer_key.verify(
            cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(cert.signature_hash_algorithm)
        )
    else:
        issuer_key.verify(
            cert.signature,
            cert.tbs_certificate_bytes,
            padding.PKCS1v15(),
            cert.signature_hash_algorithm,
        )


def _b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_apple_jws(jws: str, *, now: datetime | None = None) -> dict[str, Any]:
    """The payload of an Apple-signed JWS whose x5c chain (leaf, intermediate, root) ends at the
    pinned root, with Apple's App Store markers on the leaf and the intermediate."""
    now = now or datetime.now(UTC)
    try:
        head_b64, payload_b64, signature_b64 = jws.split(".")
        header = json.loads(_b64url_decode(head_b64))
        chain = [
            x509.load_der_x509_certificate(base64.b64decode(c)) for c in header.get("x5c") or []
        ]
    except Exception as exc:  # noqa: BLE001 - any malformed input is the same refusal
        raise BillingError("bad_signature") from exc
    if header.get("alg") != "ES256" or len(chain) != 3:  # leaf, intermediate, root
        raise BillingError("bad_signature")
    roots = {
        root.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        for root in _apple_roots()
    }
    try:
        for cert in chain:
            if not (cert.not_valid_before_utc <= now <= cert.not_valid_after_utc):
                raise BillingError("bad_signature")
        if not _has_marker(chain[0], APPLE_LEAF_OID):
            raise BillingError("bad_signature")
        if not _has_marker(chain[1], APPLE_INTERMEDIATE_OID):
            raise BillingError("bad_signature")
        for cert, issuer in zip(chain, chain[1:], strict=False):
            _verify_cert_signature(cert, issuer.public_key())
        anchor = (
            chain[-1]
            .public_key()
            .public_bytes(
                serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        )
        if anchor not in roots:
            raise BillingError("bad_signature")
        leaf_key = chain[0].public_key()
        if not isinstance(leaf_key, ec.EllipticCurvePublicKey):
            raise BillingError("bad_signature")
        raw = _b64url_decode(signature_b64)
        leaf_key.verify(
            encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
            f"{head_b64}.{payload_b64}".encode(),
            ec.ECDSA(hashes.SHA256()),
        )
        return json.loads(_b64url_decode(payload_b64))
    except BillingError:
        raise
    except Exception as exc:  # noqa: BLE001 - a failed verification is the same refusal
        raise BillingError("bad_signature") from exc


def _ms(value: Any) -> datetime | None:
    return datetime.fromtimestamp(int(value) / 1000, tz=UTC) if value else None


def _owner(
    db: Any,
    account_token: str | None,
    row: Subscription | None,
    caller_id: uuid.UUID | None,
) -> uuid.UUID | None:
    """Who the subscription belongs to: the signed account token wins, then the existing row,
    then the signed-in caller. A caller cannot claim a row linked to someone else."""
    from_token: uuid.UUID | None = None
    if account_token:
        try:
            candidate = uuid.UUID(str(account_token))
        except ValueError:
            candidate = None
        if candidate is not None and db.get(User, candidate) is not None:
            from_token = candidate
    resolved = from_token or (row.user_id if row else None) or caller_id
    if row is not None and resolved is not None and row.user_id != resolved and from_token is None:
        raise BillingError("wrong_account")
    # A signed-in caller syncing a proof that belongs to someone else (by its token or the row
    # it already made) is told so (409), never answered as if it had worked (October 28, 2026).
    if caller_id is not None and resolved is not None and resolved != caller_id:
        raise BillingError("wrong_account")
    return resolved


def _upsert(
    db: Any,
    *,
    source: str,
    external_id: str,
    user_id: uuid.UUID,
    plan: str,
    status: str,
    interval: str | None,
    renews_at: datetime | None,
    ends_at: datetime | None,
    cancel_at_period_end: bool,
) -> Subscription:
    from sqlalchemy import select

    row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
    if row is None:
        row = Subscription(
            user_id=user_id, source=source, external_id=external_id, plan=plan, status=status
        )
        db.add(row)
    row.user_id = user_id
    row.plan = plan
    row.status = status
    row.interval = interval
    row.renews_at = renews_at
    row.ends_at = ends_at
    row.cancel_at_period_end = cancel_at_period_end
    db.flush()
    return row


def apply_apple_transaction(
    db: Any,
    txn: dict[str, Any],
    renewal: dict[str, Any] | None = None,
    *,
    caller_id: uuid.UUID | None = None,
    past_due: bool = False,
    now: datetime | None = None,
) -> str:
    """One verified transaction into the subscriptions table. Returns what happened."""
    from sqlalchemy import select

    now = now or datetime.now(UTC)
    if str(txn.get("bundleId") or "") != get_settings().apns_topic:
        raise BillingError("wrong_bundle")
    mapped = product_for(str(txn.get("productId") or ""))
    if mapped is None:
        return "ignored"
    plan, interval = mapped
    external_id = f"apple:{txn['originalTransactionId']}"
    row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
    owner = _owner(db, txn.get("appAccountToken"), row, caller_id)
    if owner is None:
        return "unlinked"  # no account token and never synced: nothing to attach it to
    # Apple signs every copy of a transaction with the moment it signed it: an older copy (the
    # purchase's own proof re-sent after a refund) never overrides a newer one (October 28,
    # 2026). The newest signedDate applied is kept on the row.
    signed = _ms(txn.get("signedDate")) or datetime.fromtimestamp(0, tz=UTC)
    if row is not None and row.last_event_at is not None:
        last = row.last_event_at
        if last.tzinfo is None:
            last = last.replace(tzinfo=UTC)
        if signed < last:
            return "stale"
    expires = _ms(txn.get("expiresDate"))
    revoked = _ms(txn.get("revocationDate"))
    if revoked is not None:
        status, renews_at, ends_at = "canceled", None, revoked
    elif expires is not None and expires <= now:
        status, renews_at, ends_at = "canceled", None, expires
    elif past_due:
        status, renews_at, ends_at = "past_due", expires, None
    else:
        status, renews_at, ends_at = "active", expires, None
    auto_renew_off = bool(renewal) and str(renewal.get("autoRenewStatus")) == "0"
    _upsert(
        db,
        source="apple",
        external_id=external_id,
        user_id=owner,
        plan=plan,
        status=status,
        interval=interval,
        renews_at=renews_at,
        ends_at=ends_at if ends_at else (expires if auto_renew_off else None),
        cancel_at_period_end=auto_renew_off and status == "active",
    ).last_event_at = signed
    db.flush()
    store_entitlements(db, owner)
    return "synced"


def handle_apple_notification(db: Any, signed_payload: str, *, now: datetime | None = None) -> str:
    """One App Store Server Notification (V2), applied once by its notificationUUID."""
    from sqlalchemy import select

    now = now or datetime.now(UTC)
    payload = verify_apple_jws(signed_payload, now=now)
    event_id = str(payload.get("notificationUUID") or "")
    kind = str(payload.get("notificationType") or "")
    if not event_id:
        raise BillingError("bad_payload")
    if db.scalar(select(BillingEvent.id).where(BillingEvent.event_id == f"apple:{event_id}")):
        return "duplicate"
    data = payload.get("data") or {}
    outcome = "ignored"
    if data.get("signedTransactionInfo"):
        txn = verify_apple_jws(str(data["signedTransactionInfo"]), now=now)
        renewal = (
            verify_apple_jws(str(data["signedRenewalInfo"]), now=now)
            if data.get("signedRenewalInfo")
            else None
        )
        outcome = apply_apple_transaction(
            db,
            txn,
            renewal,
            past_due=kind == "DID_FAIL_TO_RENEW",
            now=now,
        )
    db.add(BillingEvent(event_id=f"apple:{event_id}", kind=f"apple:{kind or 'unknown'}"))
    db.flush()
    return outcome


# --- Google: the purchase token verified at the Play Developer API ----------------------------


def play_configured() -> bool:
    return get_settings().play_service_account is not None


def _play_account() -> dict[str, Any]:
    secret = get_settings().play_service_account
    if secret is None:
        raise BillingError("billing_unavailable")
    return json.loads(secret.get_secret_value())


def token_ref(purchase_token: str) -> str:
    """external_id for a Play token (tokens are longer than the column; never stored raw)."""
    return f"google:{hashlib.sha256(purchase_token.encode()).hexdigest()}"


# Play purchase tokens are URL-safe text (letters, digits, '.', '_', '-'); anything else, or
# anything absurdly long, is refused before it goes near a URL (October 28, 2026).
PLAY_ID_SHAPE = r"^[A-Za-z0-9._-]{1,1024}$"
_PLAY_TOKEN = re.compile(PLAY_ID_SHAPE)
# The shape a Play purchase id must have before it goes into a Play URL (checked at the door).
PlayPurchaseId = Annotated[str, StringConstraints(pattern=PLAY_ID_SHAPE, max_length=1024)]


def valid_play_token(purchase_token: str) -> bool:
    return bool(_PLAY_TOKEN.fullmatch(purchase_token))


def verify_play_subscription(purchase_token: str) -> dict[str, Any]:
    """The subscription behind a purchase token, from the Play Developer API (the truth)."""
    if not valid_play_token(purchase_token):
        raise BillingError("bad_token")
    account = _play_account()
    package = quote(get_settings().play_package, safe="")
    token = quote(purchase_token, safe="")
    try:
        with _client() as client:
            access = access_token(account, PLAY_SCOPE, client, now=time.time())
            response = client.get(
                f"{PLAY_API}/androidpublisher/v3/applications/{package}"
                f"/purchases/subscriptionsv2/tokens/{token}",
                headers={"authorization": f"Bearer {access}"},
            )
    except httpx2.HTTPError as exc:
        raise BillingError("play_api") from exc
    if response.status_code in (400, 404, 410):
        raise BillingError("unknown_purchase")
    if response.status_code != 200:
        raise BillingError("play_api")
    return response.json()


def _rfc3339(value: Any) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def apply_play_subscription(
    db: Any,
    purchase_token: str,
    info: dict[str, Any],
    *,
    caller_id: uuid.UUID | None = None,
    now: datetime | None = None,
) -> str:
    from sqlalchemy import select

    now = now or datetime.now(UTC)
    items = info.get("lineItems") or []
    if not items:
        return "ignored"
    mapped = product_for(str(items[-1].get("productId") or ""))
    if mapped is None:
        return "ignored"
    plan, interval = mapped
    expiry = _rfc3339(items[-1].get("expiryTime"))
    state = str(info.get("subscriptionState") or "")
    external_id = token_ref(purchase_token)
    row = db.scalar(select(Subscription).where(Subscription.external_id == external_id))
    account_token = (info.get("externalAccountIdentifiers") or {}).get(
        "obfuscatedExternalAccountId"
    )
    owner = _owner(db, account_token, row, caller_id)
    if owner is None:
        return "unlinked"
    if state == "SUBSCRIPTION_STATE_ACTIVE":
        status, cancel, renews_at, ends_at = "active", False, expiry, None
    elif state == "SUBSCRIPTION_STATE_CANCELED":
        # Auto-renew turned off; still paid up until the expiry.
        status, cancel, renews_at, ends_at = "active", True, None, expiry
    elif state in ("SUBSCRIPTION_STATE_IN_GRACE_PERIOD", "SUBSCRIPTION_STATE_ON_HOLD"):
        status, cancel, renews_at, ends_at = "past_due", False, expiry, None
    else:  # expired, revoked, paused, anything new
        status, cancel, renews_at, ends_at = "canceled", False, None, expiry or now
    _upsert(
        db,
        source="google",
        external_id=external_id,
        user_id=owner,
        plan=plan,
        status=status,
        interval=interval,
        renews_at=renews_at,
        ends_at=ends_at,
        cancel_at_period_end=cancel,
    )
    store_entitlements(db, owner)
    return "synced"


def handle_google_rtdn(db: Any, body: dict[str, Any], *, now: datetime | None = None) -> str:
    """One Real-time developer notification. Its contents are a hint only: the purchase token
    is re-verified against the Play API, so transport authenticity never matters."""
    from sqlalchemy import select

    message = body.get("message") or {}
    event_id = str(message.get("messageId") or "")
    if not event_id:
        raise BillingError("bad_payload")
    if db.scalar(select(BillingEvent.id).where(BillingEvent.event_id == f"google:{event_id}")):
        return "duplicate"
    try:
        data = json.loads(base64.b64decode(str(message.get("data") or "")))
    except Exception as exc:  # noqa: BLE001
        raise BillingError("bad_payload") from exc
    outcome = "ignored"
    notification = data.get("subscriptionNotification") or {}
    if (
        str(data.get("packageName") or "") == get_settings().play_package
        and notification.get("purchaseToken")
        and valid_play_token(str(notification["purchaseToken"]))
        and play_configured()
    ):
        token = str(notification["purchaseToken"])
        outcome = apply_play_subscription(db, token, verify_play_subscription(token), now=now)
    db.add(BillingEvent(event_id=f"google:{event_id}", kind="google:rtdn"))
    db.flush()
    return outcome
