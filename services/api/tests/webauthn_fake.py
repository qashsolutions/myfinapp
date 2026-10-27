"""A software authenticator for tests: produces real WebAuthn registration and assertion
responses (ES256, "none" attestation) that py_webauthn verifies, so the whole passkey flow
runs end to end without a browser."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

FLAG_UP = 0x01
FLAG_UV = 0x04
FLAG_AT = 0x40


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def from_b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class FakeAuthenticator:
    def __init__(self, rp_id: str = "localhost", origin: str = "http://localhost:5173") -> None:
        self.rp_id = rp_id
        self.origin = origin
        self.keys: dict[bytes, ec.EllipticCurvePrivateKey] = {}
        self.counts: dict[bytes, int] = {}

    @property
    def credential_ids(self) -> list[bytes]:
        return list(self.keys)

    def _client_data(self, kind: str, challenge: str) -> bytes:
        return json.dumps(
            {"type": kind, "challenge": challenge, "origin": self.origin, "crossOrigin": False}
        ).encode()

    def register(self, options: dict) -> dict:
        key = ec.generate_private_key(ec.SECP256R1())
        cred_id = os.urandom(16)
        self.keys[cred_id] = key
        self.counts[cred_id] = 0
        numbers = key.public_key().public_numbers()
        cose_key = cbor2.dumps(
            {
                1: 2,
                3: -7,
                -1: 1,
                -2: numbers.x.to_bytes(32, "big"),
                -3: numbers.y.to_bytes(32, "big"),
            }
        )
        auth_data = (
            hashlib.sha256(self.rp_id.encode()).digest()
            + bytes([FLAG_UP | FLAG_UV | FLAG_AT])
            + struct.pack(">I", 0)
            + bytes(16)  # AAGUID
            + struct.pack(">H", len(cred_id))
            + cred_id
            + cose_key
        )
        attestation = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        return {
            "id": b64url(cred_id),
            "rawId": b64url(cred_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(
                    self._client_data("webauthn.create", options["challenge"])
                ),
                "attestationObject": b64url(attestation),
                "transports": ["internal"],
            },
            "clientExtensionResults": {},
            "authenticatorAttachment": "platform",
        }

    def assert_(self, options: dict, credential_id: bytes | None = None) -> dict:
        allowed = [from_b64url(c["id"]) for c in options.get("allowCredentials", [])]
        cred_id = credential_id or next((c for c in allowed if c in self.keys), None)
        if cred_id is None:
            raise AssertionError("this authenticator holds none of the allowed credentials")
        key = self.keys[cred_id]
        self.counts[cred_id] += 1
        client_data = self._client_data("webauthn.get", options["challenge"])
        auth_data = (
            hashlib.sha256(self.rp_id.encode()).digest()
            + bytes([FLAG_UP | FLAG_UV])
            + struct.pack(">I", self.counts[cred_id])
        )
        signature = key.sign(
            auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256())
        )
        return {
            "id": b64url(cred_id),
            "rawId": b64url(cred_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(client_data),
                "authenticatorData": b64url(auth_data),
                "signature": b64url(signature),
                "userHandle": None,
            },
            "clientExtensionResults": {},
            "authenticatorAttachment": "platform",
        }
