"""APNs and FCM delivery for the native apps (Phase 2, chunk 2.3; spec "Notifications" → Delivery).

The shell registers a device token (`POST /api/notifications/push/native`), stored exactly like
a Web Push subscription: encrypted at rest, revoked when the service says it is gone. A payload
is the same fixed title, generic label and tag as Web Push: never an amount or a merchant.

APNs wants HTTP/2 and a JWT signed with the .p8 key (ES256); FCM v1 wants an OAuth token for
the Firebase service account (an RS256 JWT exchanged at oauth2.googleapis.com, cached until it
expires). Both calls go through `outbound_client()`, so only allowlisted hosts are ever
contacted. Without its credentials a platform is off and registration answers 503, exactly
like Web Push without VAPID keys.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx2
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from app.config import get_settings
from app.security.outbound import outbound_client
from app.services.google_auth import access_token, jwt

# Full literals so the CI allowlist scan sees the hosts; the sandbox serves dev builds.
APNS_PROD = "https://api.push.apple.com"
APNS_SANDBOX = "https://api.sandbox.push.apple.com"
FCM_SEND = "https://fcm.googleapis.com/v1/projects/{project}/messages:send"
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"  # net-allow: a JWT scope claim

PLATFORMS = ("ios", "android")
transport_override: httpx2.BaseTransport | None = None  # tests install a MockTransport here


def apns_available() -> bool:
    s = get_settings()
    return s.apns_key is not None and s.apns_key_id is not None and s.apns_team_id is not None


def fcm_available() -> bool:
    return get_settings().fcm_service_account is not None


def available(platform: str) -> bool:
    if platform == "ios":
        return apns_available()
    if platform == "android":
        return fcm_available()
    return False


def any_available() -> bool:
    return apns_available() or fcm_available()


def _client() -> httpx2.Client:
    kwargs: dict[str, Any] = {}
    if transport_override is not None:
        kwargs["transport"] = transport_override
    try:
        return outbound_client(http2=True, **kwargs)  # APNs requires HTTP/2
    except ImportError:  # pragma: no cover - the http2 extra is a locked dependency
        return outbound_client(**kwargs)


def _apns_jwt(now: float) -> str:
    s = get_settings()
    key = serialization.load_pem_private_key(
        s.apns_key.get_secret_value().encode(),  # type: ignore[union-attr] - guarded by available()
        password=None,
    )
    assert isinstance(key, ec.EllipticCurvePrivateKey)

    def sign(data: bytes) -> bytes:
        der = key.sign(data, ec.ECDSA(hashes.SHA256()))
        r, sig_s = utils.decode_dss_signature(der)
        return r.to_bytes(32, "big") + sig_s.to_bytes(32, "big")

    return jwt(
        {"alg": "ES256", "kid": s.apns_key_id}, {"iss": s.apns_team_id, "iat": int(now)}, sign
    )


def send_apns(token: str, payload: dict[str, Any], *, now: float | None = None) -> int:
    """POST one alert to APNs. Returns the status; 410 means the token is gone."""
    if not apns_available():
        raise RuntimeError("apns is not configured")
    s = get_settings()
    base = APNS_SANDBOX if s.apns_use_sandbox else APNS_PROD
    headers = {
        "authorization": f"bearer {_apns_jwt(now or time.time())}",
        "apns-topic": s.apns_topic,
        "apns-push-type": "alert",
        "apns-collapse-id": str(payload.get("tag", ""))[:63],
        "apns-priority": "5",
    }
    body = {
        "aps": {
            "alert": {"title": payload["title"], "body": payload["body"]},
            "thread-id": payload.get("tag", ""),
        },
        "url": payload.get("url", "/"),
    }
    with _client() as client:
        return client.post(f"{base}/3/device/{token}", headers=headers, json=body).status_code


def _fcm_account() -> dict[str, Any]:
    secret = get_settings().fcm_service_account
    if secret is None:
        raise RuntimeError("fcm is not configured")
    return json.loads(secret.get_secret_value())


def send_fcm(token: str, payload: dict[str, Any], *, now: float | None = None) -> int:
    """POST one message to FCM v1. Returns the status; 404 means the token is gone."""
    account = _fcm_account()
    message = {
        "message": {
            "token": token,
            "notification": {"title": payload["title"], "body": payload["body"]},
            "data": {"url": payload.get("url", "/"), "tag": str(payload.get("tag", ""))},
            "android": {"notification": {"tag": str(payload.get("tag", ""))}},
        }
    }
    with _client() as client:
        access = access_token(account, FCM_SCOPE, client, now=now or time.time())
        return client.post(
            FCM_SEND.format(project=account["project_id"]),
            headers={"authorization": f"Bearer {access}"},
            json=message,
        ).status_code


def send(platform: str, token: str, payload: dict[str, Any]) -> int:
    if platform == "ios":
        return send_apns(token, payload)
    if platform == "android":
        return send_fcm(token, payload)
    raise RuntimeError(f"unknown push platform: {platform}")
