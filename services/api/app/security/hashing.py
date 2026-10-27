from __future__ import annotations

import hashlib
import hmac

from app.config import get_settings


def token_hash(token: str) -> str:
    """HMAC-SHA256 (64 hex) of a bearer secret (session token, one-time code) for storage.

    A database leak then reveals nothing usable without STACKD_SECRET_KEY.
    """
    key = get_settings().secret_key.get_secret_value().encode()
    return hmac.new(key, token.encode(), hashlib.sha256).hexdigest()


def pseudonym(value: str) -> str:
    """Keyed hash (HMAC-SHA256, 32 hex chars) of a client identifier such as an IP or email.

    Stable within a deployment, so abuse can be correlated across requests, but not
    reversible or linkable across deployments without STACKD_IP_HASH_KEY.
    """
    key = get_settings().ip_hash_key.get_secret_value().encode()
    return hmac.new(key, value.strip().lower().encode(), hashlib.sha256).hexdigest()[:32]
