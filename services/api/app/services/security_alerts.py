"""Always-on security alerts (docs/spec.md "Account security (day 1)").

Email now; push joins in chunk 1.13. Users cannot turn these off, so there is no
preference check here by design. Each alert names the device and the time, never amounts.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from fastapi import BackgroundTasks
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models.user import User
from app.services.email import Message, get_sender
from app.services.otp import OtpError


class SecurityEvent(StrEnum):
    NEW_SIGN_IN = "new_sign_in"
    PASSKEY_ADDED = "passkey_added"
    PASSKEY_REMOVED = "passkey_removed"
    DEVICE_SIGNED_OUT = "device_signed_out"
    EXPORT_REQUESTED = "export_requested"
    EMAIL_CHANGED = "email_changed"
    DELETION_REQUESTED = "deletion_requested"
    PLAN_CHANGED = "plan_changed"
    BANK_CONNECTED = "bank_connected"  # Phase 3
    BANK_DISCONNECTED = "bank_disconnected"  # Phase 3
    BANK_AUTO_REVOKED = "bank_auto_revoked"  # chunk 3.4
    DEVICE_LINKED = "device_linked"  # "Link with your phone" (October 19, 2026)
    CODES_LOCKED = "codes_locked"  # October 24, 2026
    BACKUP_KEY_CHANGED = "backup_key_changed"  # October 24, 2026
    BACKUP_TURNED_OFF = "backup_turned_off"  # October 24, 2026


# (subject, first line). {device} and {when} are filled in.
TEMPLATES: dict[SecurityEvent, tuple[str, str]] = {
    SecurityEvent.NEW_SIGN_IN: (
        "New sign-in to Qash",
        "Someone signed in on {device} at {when}.",
    ),
    SecurityEvent.PASSKEY_ADDED: (
        "A passkey was added",
        "A new passkey was added on {device} at {when}.",
    ),
    SecurityEvent.PASSKEY_REMOVED: (
        "A passkey was removed",
        "A passkey was removed from your account at {when} using {device}.",
    ),
    SecurityEvent.DEVICE_LINKED: (
        "New sign-in to Qash",
        "Your phone approved a sign-in on {device} at {when}.",
    ),
    SecurityEvent.CODES_LOCKED: (
        "Several wrong codes were tried for your account",
        "Several wrong email codes were entered for your account on {device} at {when}, so "
        "email codes are paused for 15 minutes. If that was you, wait and try again. If not, "
        "nobody got in, and your passkey still signs you in as usual. These alerts are always on.",
    ),
    SecurityEvent.BACKUP_KEY_CHANGED: (
        "Your backup was set up again",
        "Encrypted backup was set up again with a new key on {device} at {when}. "
        "Your old recovery key no longer opens it.",
    ),
    SecurityEvent.BACKUP_TURNED_OFF: (
        "Encrypted backup was turned off",
        "Encrypted backup was turned off and its copies deleted on {device} at {when}. "
        "Your data stays on your devices.",
    ),
    SecurityEvent.DEVICE_SIGNED_OUT: (
        "A device was signed out",
        "{device} was signed out at {when}.",
    ),
    SecurityEvent.EXPORT_REQUESTED: (
        "Your data export was requested",
        "An export of your data was requested on {device} at {when}.",
    ),
    SecurityEvent.EMAIL_CHANGED: (
        "Your email address changed",
        "The email on your account was changed on {device} at {when}.",
    ),
    SecurityEvent.DELETION_REQUESTED: (
        "Account deletion requested",
        "Deletion of your account was requested on {device} at {when}.",
    ),
    SecurityEvent.PLAN_CHANGED: (
        "Your plan changed",
        "Your plan was changed on {device} at {when}.",
    ),
    SecurityEvent.BANK_CONNECTED: (
        "A bank was connected",
        "A bank was connected on {device} at {when}.",
    ),
    SecurityEvent.BANK_DISCONNECTED: (
        "A bank was disconnected",
        "A bank was disconnected on {device} at {when}.",
    ),
    SecurityEvent.BANK_AUTO_REVOKED: (
        "We turned off a bank connection",
        "Qash hadn't been opened for 60 days, so at {when} we turned off a bank connection and "
        "asked the bank's provider to forget our access. Your accounts and entries stay on your "
        "device, and you can link the bank again any time.",
    ),
}

FOOTER = (
    "\n\nIf this was you, there's nothing to do. If it wasn't, open Qash, go to Me, then "
    "Security, and sign out the device you don't recognise. These alerts are always on."
)


def send_alert(to: str, event: SecurityEvent, *, device_label: str, at: datetime) -> Message:
    subject, line = TEMPLATES[event]
    when = at.strftime("%b %-d, %Y %H:%M UTC")
    # An alert about something we did on our own (dormancy) has no "if this was you" footer.
    # Nor does a lockout, where no device got in to sign out.
    no_footer = {SecurityEvent.BANK_AUTO_REVOKED, SecurityEvent.CODES_LOCKED}
    footer = "" if event in no_footer else FOOTER
    message = Message(
        to=to, subject=subject, text=line.format(device=device_label, when=when) + footer
    )
    get_sender().send(message)
    return message


def alert_if_locked(
    db: DbSession,
    exc: OtpError,
    email: str,
    *,
    device_label: str,
    background: BackgroundTasks | None = None,
) -> None:
    """The attempt that locks an address's codes tells that account's owner, once per lockout
    (October 24, 2026). Addresses with no live account get nothing. With `background` the
    email goes after the answer, so a public route takes the same time either way."""
    if exc.code != "locked" or not exc.just_locked:
        return
    user = db.scalar(select(User).where(User.email == email, User.deleted_at.is_(None)))
    if user is None:
        return
    at = datetime.now(UTC)
    if background is not None:
        background.add_task(
            send_alert, user.email, SecurityEvent.CODES_LOCKED, device_label=device_label, at=at
        )
    else:
        send_alert(user.email, SecurityEvent.CODES_LOCKED, device_label=device_label, at=at)
