"""Verify a Plaid webhook (docs/security/linking.md): the `Plaid-Verification` header is an ES256
JWT signed by a key Plaid publishes by id. The JWT must be fresh (5 minutes) and carry the
SHA-256 of the exact body we received, so a replayed or altered body fails."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from app.linking import plaid

MAX_AGE_SECONDS = 300
# kid -> (JWK, when fetched). Re-read after a day so a key Plaid has expired stops working.
_keys: dict[str, tuple[dict[str, Any], float]] = {}
KEY_TTL_SECONDS = 86400
# A made-up kid must not make us call Plaid on every request (October 24, 2026): an unknown kid
# is remembered for 10 minutes, and at most 10 key lookups go out a minute in all.
_missing: dict[str, float] = {}
MISSING_TTL_SECONDS = 600
_lookups: list[float] = []
LOOKUPS_PER_MINUTE = 10


def reset() -> None:
    """Forget cached keys, misses and the lookup budget (tests)."""
    _keys.clear()
    _missing.clear()
    _lookups.clear()


def _key_for(kid: str, now: float) -> dict[str, Any]:
    cached = _keys.get(kid)
    if cached is not None and now - cached[1] < KEY_TTL_SECONDS:
        return cached[0]
    if now - _missing.get(kid, -MISSING_TTL_SECONDS) < MISSING_TTL_SECONDS:
        raise WebhookError("key_unavailable")
    _lookups[:] = [t for t in _lookups if now - t < 60]
    if len(_lookups) >= LOOKUPS_PER_MINUTE:
        raise WebhookError("key_unavailable")
    _lookups.append(now)
    try:
        jwk = plaid.webhook_key(kid)
    except plaid.LinkError as exc:
        _missing[kid] = now
        raise WebhookError("key_unavailable") from exc
    if jwk.get("expired_at"):  # Plaid marks a retired key; it must not verify anything
        _missing[kid] = now
        raise WebhookError("key_unavailable")
    _keys[kid] = (jwk, now)
    _missing.pop(kid, None)
    return jwk


class WebhookError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _public_key(jwk: dict[str, Any]) -> ec.EllipticCurvePublicKey:
    x = int.from_bytes(_b64url(jwk["x"]), "big")
    y = int.from_bytes(_b64url(jwk["y"]), "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


def verify(body: bytes, token: str, *, now: datetime | None = None) -> dict[str, Any]:
    """The webhook's JSON body, once the signature, age and body hash all check out."""
    try:
        header_b64, claims_b64, sig_b64 = token.split(".")
        header = json.loads(_b64url(header_b64))
        claims = json.loads(_b64url(claims_b64))
        signature = _b64url(sig_b64)
    except (ValueError, json.JSONDecodeError) as exc:
        raise WebhookError("bad_signature") from exc
    if header.get("alg") != "ES256" or not header.get("kid") or len(signature) != 64:
        raise WebhookError("bad_signature")
    kid = str(header["kid"])
    jwk = _key_for(kid, time.time())
    der = encode_dss_signature(
        int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
    )
    try:
        _public_key(jwk).verify(
            der, f"{header_b64}.{claims_b64}".encode(), ec.ECDSA(hashes.SHA256())
        )
    except (InvalidSignature, ValueError, KeyError) as exc:
        raise WebhookError("bad_signature") from exc
    issued = claims.get("iat")
    current = (now or datetime.now(UTC)).timestamp()
    if not isinstance(issued, int | float) or not 0 <= current - issued <= MAX_AGE_SECONDS:
        raise WebhookError("stale")
    expected = str(claims.get("request_body_sha256") or "")
    if not hmac.compare_digest(expected, hashlib.sha256(body).hexdigest()):
        raise WebhookError("body_mismatch")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise WebhookError("bad_body") from exc
    if not isinstance(payload, dict):
        raise WebhookError("bad_body")
    return payload
