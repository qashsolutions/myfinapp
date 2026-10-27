"""Provider tokens at rest (docs/security/linking.md "Token handling").

Sealed with Fernet (AES-128-CBC + HMAC-SHA256) under STACKD_LINK_TOKEN_KEY, a key used for
nothing else. Each row records `key_id`, so a rotation can find what the old key sealed.
Plaintext exists only inside the request that calls the provider; never logged or returned.
"""

from __future__ import annotations

import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


class VaultError(Exception):
    pass


def _key() -> bytes:
    secret = get_settings().link_token_key
    if secret is None or not secret.get_secret_value().strip():
        raise VaultError("no_key")
    return secret.get_secret_value().strip().encode()


def key_id() -> str:
    return hashlib.sha256(_key()).hexdigest()[:16]


def seal(plaintext: str) -> str:
    return Fernet(_key()).encrypt(plaintext.encode()).decode()


def open_(sealed: str) -> str:
    try:
        return Fernet(_key()).decrypt(sealed.encode()).decode()
    except InvalidToken as exc:
        raise VaultError("bad_token") from exc
