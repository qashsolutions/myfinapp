"""Passkeys (WebAuthn) via py_webauthn.

Registration creates a credential bound to the user; assertion proves possession and user
verification (Face ID, Touch ID, fingerprint or device passcode: the platform decides).
Challenges are stored per device and consumed once. Nothing private is ever stored.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, options_to_json
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.config import get_settings
from app.models.user import User
from app.models.webauthn_challenge import WebauthnChallenge
from app.models.webauthn_credential import WebauthnCredential
from app.services.account_lock import lock_account

CHALLENGE_TTL = timedelta(minutes=5)


class WebauthnError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def credentials_for(db: DbSession, user_id: uuid.UUID) -> list[WebauthnCredential]:
    stmt = (
        select(WebauthnCredential)
        .where(WebauthnCredential.user_id == user_id)
        .order_by(WebauthnCredential.created_at)
    )
    return list(db.scalars(stmt))


def _store_challenge(
    db: DbSession,
    *,
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    kind: str,
    challenge: bytes,
    now: datetime,
) -> None:
    db.add(
        WebauthnChallenge(
            user_id=user_id,
            session_id=session_id,
            kind=kind,
            challenge=challenge,
            expires_at=now + CHALLENGE_TTL,
        )
    )
    db.flush()


def _take_challenge(
    db: DbSession, *, user_id: uuid.UUID, session_id: uuid.UUID, kind: str, now: datetime
) -> bytes:
    stmt = (
        select(WebauthnChallenge)
        .where(
            WebauthnChallenge.user_id == user_id,
            WebauthnChallenge.session_id == session_id,
            WebauthnChallenge.kind == kind,
            WebauthnChallenge.consumed_at.is_(None),
        )
        .order_by(WebauthnChallenge.created_at.desc())
        .limit(1)
        # Locked, so one signed answer sent several times at once is checked once (invariant
        # 32): a synced passkey's sign count stays 0 and cannot catch the replay.
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    row = db.scalars(stmt).first()
    if row is None or row.expires_at <= now:
        raise WebauthnError("no_challenge")
    row.consumed_at = now
    db.flush()
    return row.challenge


def registration_options(
    db: DbSession, user: User, *, session_id: uuid.UUID, now: datetime | None = None
) -> str:
    """JSON for navigator.credentials.create(); existing passkeys are excluded."""
    s = get_settings()
    now = now or datetime.now(UTC)
    existing = credentials_for(db, user.id)
    options = generate_registration_options(
        rp_id=s.rp_id,
        rp_name=s.rp_name,
        user_id=user.id.bytes,
        user_name=user.email,
        user_display_name=user.display_name or user.email,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=c.credential_id) for c in existing],
    )
    _store_challenge(
        db,
        user_id=user.id,
        session_id=session_id,
        kind="register",
        challenge=options.challenge,
        now=now,
    )
    return options_to_json(options)


def verify_registration(
    db: DbSession,
    user: User,
    credential: dict,
    *,
    session_id: uuid.UUID,
    device_label: str,
    now: datetime | None = None,
) -> WebauthnCredential:
    s = get_settings()
    now = now or datetime.now(UTC)
    challenge = _take_challenge(
        db, user_id=user.id, session_id=session_id, kind="register", now=now
    )
    try:
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=s.rp_id,
            expected_origin=s.origins,
            require_user_verification=True,
        )
    except InvalidRegistrationResponse as exc:
        raise WebauthnError("invalid_credential") from exc
    transports = credential.get("response", {}).get("transports") or []
    row = WebauthnCredential(
        user_id=user.id,
        credential_id=verified.credential_id,
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
        transports=",".join(str(t) for t in transports)[:120] or None,
        device_label=device_label[:80],
        last_used_at=now,
    )
    db.add(row)
    db.flush()
    return row


def authentication_options(
    db: DbSession,
    user: User,
    *,
    session_id: uuid.UUID,
    now: datetime | None = None,
    prf_salt: bytes | None = None,
) -> str:
    """JSON for navigator.credentials.get(), limited to this user's passkeys.

    With `prf_salt`, the PRF extension is requested so the device can derive the backup
    key-wrapping secret from the passkey (docs/spec.md "End-to-end encrypted backup"). The
    output stays on the device; the server only ever sees the salt it was given.
    """
    s = get_settings()
    now = now or datetime.now(UTC)
    creds = credentials_for(db, user.id)
    if not creds:
        raise WebauthnError("no_passkeys")
    options = generate_authentication_options(
        rp_id=s.rp_id,
        allow_credentials=[PublicKeyCredentialDescriptor(id=c.credential_id) for c in creds],
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    _store_challenge(
        db,
        user_id=user.id,
        session_id=session_id,
        kind="assert",
        challenge=options.challenge,
        now=now,
    )
    payload = json.loads(options_to_json(options))
    if prf_salt is not None:
        payload["extensions"] = {"prf": {"eval": {"first": bytes_to_base64url(prf_salt)}}}
    return json.dumps(payload)


def verify_authentication(
    db: DbSession,
    user: User,
    credential: dict,
    *,
    session_id: uuid.UUID,
    now: datetime | None = None,
) -> WebauthnCredential:
    s = get_settings()
    now = now or datetime.now(UTC)
    challenge = _take_challenge(db, user_id=user.id, session_id=session_id, kind="assert", now=now)
    try:
        raw_id = base64url_to_bytes(credential["rawId"])
    except (KeyError, TypeError, ValueError) as exc:
        raise WebauthnError("invalid_credential") from exc
    stmt = select(WebauthnCredential).where(
        WebauthnCredential.user_id == user.id, WebauthnCredential.credential_id == raw_id
    )
    row = db.scalars(stmt).first()
    if row is None:
        raise WebauthnError("unknown_credential")
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=s.rp_id,
            expected_origin=s.origins,
            credential_public_key=row.public_key,
            credential_current_sign_count=row.sign_count,
            require_user_verification=True,
        )
    except InvalidAuthenticationResponse as exc:
        raise WebauthnError("invalid_credential") from exc
    row.sign_count = verified.new_sign_count
    row.last_used_at = now
    db.flush()
    return row


def signin_options(db: DbSession, *, now: datetime | None = None) -> str:
    """A passkey sign-in with nobody known yet (October 13, 2026): no allow-list, so the device
    offers the passkeys it holds for this site (synced through iCloud Keychain or Google
    Password Manager). The challenge is stored without a user and consumed once."""
    s = get_settings()
    now = now or datetime.now(UTC)
    options = generate_authentication_options(
        rp_id=s.rp_id, user_verification=UserVerificationRequirement.REQUIRED
    )
    db.add(
        WebauthnChallenge(
            user_id=None,
            session_id=None,
            kind="signin",
            challenge=options.challenge,
            expires_at=now + CHALLENGE_TTL,
        )
    )
    db.flush()
    return options_to_json(options)


def _signed_challenge(credential: dict) -> bytes:
    """The challenge the browser signed, read from clientDataJSON (verified again below)."""
    try:
        client_data = json.loads(base64url_to_bytes(credential["response"]["clientDataJSON"]))
        return base64url_to_bytes(client_data["challenge"])
    except (KeyError, TypeError, ValueError) as exc:
        raise WebauthnError("invalid_credential") from exc


def verify_signin(
    db: DbSession, credential: dict, *, now: datetime | None = None
) -> tuple[User, WebauthnCredential]:
    """Check a passkey sign-in: the challenge is one we issued, unused and fresh; the passkey is
    registered to a live account; the signature, origin, RP id and user verification hold."""
    s = get_settings()
    now = now or datetime.now(UTC)
    challenge = _signed_challenge(credential)
    row = db.scalars(
        select(WebauthnChallenge)
        .where(
            WebauthnChallenge.kind == "signin",
            WebauthnChallenge.challenge == challenge,
            WebauthnChallenge.consumed_at.is_(None),
            WebauthnChallenge.expires_at > now,
        )
        .with_for_update()
    ).first()
    if row is None:
        raise WebauthnError("no_challenge")
    row.consumed_at = now
    try:
        raw_id = base64url_to_bytes(credential["rawId"])
    except (KeyError, TypeError, ValueError) as exc:
        raise WebauthnError("invalid_credential") from exc
    cred = db.scalars(
        select(WebauthnCredential).where(WebauthnCredential.credential_id == raw_id)
    ).first()
    user = db.get(User, cred.user_id) if cred is not None else None
    if user is not None:
        # The account's lock before any write to its passkey or sessions: a passkey sign-in
        # cancels a recovery, which takes the same lock first (invariant 74).
        lock_account(db, user.id)
        # Read again under the lock: a recovery that finished meanwhile removed it.
        cred = db.scalars(
            select(WebauthnCredential)
            .where(WebauthnCredential.credential_id == raw_id)
            .execution_options(populate_existing=True)
        ).first()
    if cred is None or user is None or user.deleted_at is not None:
        db.flush()
        raise WebauthnError("unknown_credential")
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=s.rp_id,
            expected_origin=s.origins,
            credential_public_key=cred.public_key,
            credential_current_sign_count=cred.sign_count,
            require_user_verification=True,
        )
    except InvalidAuthenticationResponse as exc:
        db.flush()
        raise WebauthnError("invalid_credential") from exc
    cred.sign_count = verified.new_sign_count
    cred.last_used_at = now
    row.user_id = user.id
    db.flush()
    return user, cred


def options_payload(options_json: str) -> dict:
    return json.loads(options_json)
