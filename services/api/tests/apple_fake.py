"""A pretend App Store signing chain (root → intermediate → leaf, all EC P-256) so the Apple
JWS verification runs for real in tests: tests/_env.py pins STACKD_APPLE_ROOT_CA to this root,
and `sign_jws` produces payloads exactly shaped like Apple's. Generated per run; never real."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.x509.oid import NameOID


def _name(common: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common)])


def _cert(
    subject: str, issuer: str, public_key: Any, signing_key: ec.EllipticCurvePrivateKey
) -> x509.Certificate:
    now = datetime.now(UTC)
    return (
        x509.CertificateBuilder()
        .subject_name(_name(subject))
        .issuer_name(_name(issuer))
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=365))
        .sign(signing_key, hashes.SHA256())
    )


_root_key = ec.generate_private_key(ec.SECP256R1())
_intermediate_key = ec.generate_private_key(ec.SECP256R1())
_leaf_key = ec.generate_private_key(ec.SECP256R1())
_root = _cert("Fake Apple Root", "Fake Apple Root", _root_key.public_key(), _root_key)
_intermediate = _cert(
    "Fake Apple Intermediate", "Fake Apple Root", _intermediate_key.public_key(), _root_key
)
_leaf = _cert(
    "Fake App Store Signing", "Fake Apple Intermediate", _leaf_key.public_key(), _intermediate_key
)

ROOT_PEM = _root.public_bytes(serialization.Encoding.PEM).decode()
X5C = [
    base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()
    for cert in (_leaf, _intermediate, _root)
]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def sign_jws(payload: dict[str, Any], *, x5c: list[str] | None = None) -> str:
    signing = (
        _b64url(json.dumps({"alg": "ES256", "x5c": x5c or X5C}).encode())
        + "."
        + _b64url(json.dumps(payload).encode())
    )
    der = _leaf_key.sign(signing.encode(), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return signing + "." + _b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
