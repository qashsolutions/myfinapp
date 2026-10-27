"""OAuth for Google service accounts (FCM v1, the Play Developer API): an RS256 JWT exchanged
for a short-lived access token at the account's token endpoint, cached per account and scope.
The caller supplies the HTTP client, so each service keeps its own transport override and the
allowlist check stays where the request is made.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from typing import Any

import httpx2
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

_cache: dict[tuple[str, str], tuple[float, str]] = {}  # (email, scope) -> (good until, token)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def jwt(header: dict[str, Any], claims: dict[str, Any], sign: Callable[[bytes], bytes]) -> str:
    signing = (
        b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64url(json.dumps(claims, separators=(",", ":")).encode())
    )
    return signing + "." + b64url(sign(signing.encode()))


def access_token(account: dict[str, Any], scope: str, client: httpx2.Client, *, now: float) -> str:
    key = (str(account["client_email"]), scope)
    cached = _cache.get(key)
    if cached is not None and cached[0] > now:
        return cached[1]
    private = serialization.load_pem_private_key(account["private_key"].encode(), password=None)
    assertion = jwt(
        {"alg": "RS256", "typ": "JWT"},
        {
            "iss": account["client_email"],
            "scope": scope,
            "aud": account["token_uri"],
            "iat": int(now),
            "exp": int(now) + 3600,
        },
        lambda data: private.sign(data, padding.PKCS1v15(), hashes.SHA256()),  # type: ignore[union-attr]
    )
    response = client.post(
        account["token_uri"],
        data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
    )
    response.raise_for_status()
    data = response.json()
    _cache[key] = (now + float(data.get("expires_in", 3600)) - 300, str(data["access_token"]))
    return _cache[key][1]


def reset_cache() -> None:
    _cache.clear()
