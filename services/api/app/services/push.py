"""Web Push (VAPID) delivery (docs/spec.md "Notifications" → Delivery).

Subscriptions are stored encrypted at rest (Fernet, key derived from STACKD_SECRET_KEY).
The payload is encrypted for the browser by pywebpush (aes128gcm) and signed with our VAPID
key; the HTTP call itself goes through `outbound_client()`, so only allowlisted push services
are ever contacted. A payload is a fixed title, a generic label and a tag: never an amount.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any
from urllib.parse import urlparse

import httpx2
from cryptography.fernet import Fernet
from py_vapid import Vapid
from pywebpush import WebPusher

from app.config import get_settings
from app.security.outbound import outbound_client

TTL_SECONDS = 24 * 3600
transport_override: httpx2.BaseTransport | None = None  # tests install a MockTransport here


def _fernet() -> Fernet:
    secret = get_settings().secret_key.get_secret_value().encode()
    key = base64.urlsafe_b64encode(hashlib.sha256(b"push-subscription:" + secret).digest())
    return Fernet(key)


def encrypt_subscription(subscription: dict[str, Any]) -> str:
    return _fernet().encrypt(json.dumps(subscription, sort_keys=True).encode()).decode()


def decrypt_subscription(text: str) -> dict[str, Any]:
    return json.loads(_fernet().decrypt(text.encode()))


def endpoint_hash(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode()).hexdigest()


def push_available() -> bool:
    s = get_settings()
    return s.vapid_private_key is not None and s.vapid_public_key is not None


def public_key() -> str | None:
    return get_settings().vapid_public_key if push_available() else None


def build_request(
    subscription: dict[str, Any], payload: dict[str, Any], *, now: float | None = None
) -> tuple[str, dict[str, str], bytes]:
    """Endpoint, headers and the encrypted body for one push."""
    s = get_settings()
    if s.vapid_private_key is None:
        raise RuntimeError("push is not configured")
    endpoint = str(subscription["endpoint"])
    body = WebPusher(subscription).encode(json.dumps(payload).encode())["body"]
    parsed = urlparse(endpoint)
    vapid = Vapid.from_pem(s.vapid_private_key.get_secret_value().encode())
    headers = dict(
        vapid.sign(
            {
                "aud": f"{parsed.scheme}://{parsed.netloc}",
                "sub": s.vapid_subject,
                "exp": int((now or time.time()) + 12 * 3600),
            }
        )
    )
    headers.update(
        {
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(TTL_SECONDS),
            "Urgency": "normal",
        }
    )
    return endpoint, headers, body


def send(subscription: dict[str, Any], payload: dict[str, Any]) -> int:
    """POST one push. Returns the push service's status; 404 / 410 mean it is gone."""
    endpoint, headers, body = build_request(subscription, payload)
    kwargs: dict[str, Any] = {}
    if transport_override is not None:
        kwargs["transport"] = transport_override
    with outbound_client(**kwargs) as client:
        response = client.post(endpoint, headers=headers, content=body)
        return response.status_code


def deliver(subscription: dict[str, Any], payload: dict[str, Any]) -> int:
    """One stored subscription to its service: Web Push, or APNs / FCM (chunk 2.3)."""
    if "endpoint" in subscription:
        return send(subscription, payload)
    from app.services import push_native

    return push_native.send(subscription["platform"], subscription["token"], payload)
