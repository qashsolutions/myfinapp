"""Sign-up and sign-in: email code, mandatory passkey, lock, step-up, devices, alerts."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from app.db import get_session_factory
from app.services.otp import OtpError, normalize_email, request_code, verify_code
from tests.auth_flow import (
    MAC_UA,
    assert_passkey,
    new_client,
    outbox,
    register_passkey,
    send_code,
    sign_in_with_code,
    sign_up,
)
from tests.webauthn_fake import FakeAuthenticator


def _email() -> str:
    return f"maya+{uuid.uuid4().hex[:8]}@example.com"


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def test_signup_is_email_code_then_passkey() -> None:
    email = _email()
    client = new_client()
    info = sign_in_with_code(client, email, display_mode="standalone")
    assert info["authenticated"] is True
    assert info["has_passkeys"] is False
    assert info["locked"] is True  # usable only after the passkey
    assert info["device_label"] == "Safari on iPhone · Home Screen app"
    assert info["user"]["email"] == email

    # Locked sessions cannot read app data
    assert client.get("/api/security/passkeys").status_code == 403
    assert client.get("/api/security/passkeys").json() == {"detail": "locked"}

    authenticator = FakeAuthenticator()
    passkey = register_passkey(client, authenticator)
    assert passkey["label"] == "iPhone passkey"

    info = client.get("/api/auth/session").json()
    assert info["has_passkeys"] is True
    assert info["locked"] is False
    assert info["passkey_verified_at"] is not None
    assert [p["label"] for p in client.get("/api/security/passkeys").json()] == ["iPhone passkey"]

    subjects = [m.subject for m in outbox()]
    assert subjects[0].startswith("Your Qash code: ")
    assert "A passkey was added" in subjects
    assert all(m.to == email for m in outbox())


def test_code_is_six_digits_and_the_email_never_leaks_the_account_state() -> None:
    email = _email()
    client = new_client()
    code = send_code(client, email)
    assert len(code) == 6 and code.isdigit()
    assert "no password" in outbox()[-1].text.lower() or "passkey" in outbox()[-1].text


def test_wrong_code_five_times_locks_for_15_minutes() -> None:
    email = _email()
    client = new_client()
    real = send_code(client, email)
    wrong = "000000" if real != "000000" else "111111"
    for attempt in range(4):
        r = client.post("/api/auth/otp/verify", json={"email": email, "code": wrong})
        assert r.status_code == 400
        assert r.json()["detail"] == {"code": "wrong_code", "attempts_left": 4 - attempt}
    r = client.post("/api/auth/otp/verify", json={"email": email, "code": wrong})
    assert r.status_code == 423
    assert r.json()["detail"] == "locked"
    assert 890 <= int(r.headers["retry-after"]) <= 900
    # the right code no longer works, and no new code is issued during the lockout
    assert (
        client.post("/api/auth/otp/verify", json={"email": email, "code": real}).status_code == 423
    )
    assert client.post("/api/auth/otp/send", json={"email": email}).status_code == 423


def test_resend_has_a_cooldown_and_retires_the_old_code() -> None:
    email = _email()
    client = new_client()
    first = send_code(client, email)
    r = client.post("/api/auth/otp/send", json={"email": email})
    assert r.status_code == 429
    assert r.json()["detail"] == "too_soon"
    assert 1 <= int(r.headers["retry-after"]) <= 60
    # after the cooldown a new code replaces the first one
    with get_session_factory()() as db, db.begin():
        later = datetime.now(UTC) + timedelta(seconds=61)
        second, _ = request_code(db, normalize_email(email), ip=None, now=later)
        with pytest.raises(OtpError) as exc:
            verify_code(db, normalize_email(email), first, now=later)
        assert exc.value.code == "wrong_code"
        assert verify_code(db, normalize_email(email), second, now=later).consumed_at is not None


def test_code_is_single_use_and_expires() -> None:
    email = normalize_email(_email())
    now = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
    with get_session_factory()() as db, db.begin():
        code, _ = request_code(db, email, ip="203.0.113.9", now=now)
        verify_code(db, email, code, now=now + timedelta(minutes=1))
        with pytest.raises(OtpError) as exc:
            verify_code(db, email, code, now=now + timedelta(minutes=2))
        assert exc.value.code == "no_code"
        code2, _ = request_code(db, email, ip=None, now=now + timedelta(minutes=5))
        with pytest.raises(OtpError) as exc:
            verify_code(db, email, code2, now=now + timedelta(minutes=16))
        assert exc.value.code == "expired"


def test_returning_user_on_a_new_device_gets_an_alert_and_unlocks_with_the_passkey() -> None:
    email = _email()
    authenticator = FakeAuthenticator()
    phone = new_client()
    sign_up(phone, email, authenticator)
    outbox().clear()

    laptop = new_client(MAC_UA)
    info = sign_in_with_code(laptop, email)
    assert info["has_passkeys"] is True
    assert info["locked"] is True  # this device has not passed a passkey check yet
    assert [m.subject for m in outbox()] == [outbox()[0].subject, "New sign-in to Qash"]
    assert "Chrome on Mac" in outbox()[-1].text

    result = assert_passkey(laptop, authenticator)  # synced passkey, or the same authenticator
    assert result["locked"] is False
    devices = laptop.get("/api/security/devices").json()
    assert [d["label"] for d in devices] == ["Chrome on Mac", "Safari on iPhone"]
    assert [d["current"] for d in devices] == [True, False]

    # Sign the phone out from the laptop: step-up is fresh, so it goes through
    phone_session = next(d for d in devices if not d["current"])
    r = laptop.delete(f"/api/security/devices/{phone_session['id']}")
    assert r.status_code == 204
    assert phone.get("/api/auth/session").json()["authenticated"] is False
    assert outbox()[-1].subject == "A device was signed out"
    assert "Safari on iPhone" in outbox()[-1].text


def _age_session(session_id: str, *, minutes: float) -> None:
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET last_seen_at = now() - (:m || ' minutes')::interval, "
                "passkey_verified_at = now() - (:m || ' minutes')::interval WHERE id = :id"
            ),
            {"m": str(minutes), "id": session_id},
        )


def test_locks_after_five_minutes_without_activity() -> None:
    email = _email()
    authenticator = FakeAuthenticator()
    client = new_client()
    info = sign_up(client, email, authenticator)
    _age_session(info["session_id"], minutes=4.5)
    assert client.get("/api/auth/session").json()["locked"] is False
    _age_session(info["session_id"], minutes=5.5)
    assert client.get("/api/auth/session").json()["locked"] is True
    assert client.get("/api/security/devices").status_code == 403
    assert_passkey(client, authenticator)
    assert client.get("/api/auth/session").json()["locked"] is False
    assert client.get("/api/security/devices").status_code == 200


def test_step_up_is_needed_to_remove_a_passkey_and_the_last_one_stays() -> None:
    email = _email()
    authenticator = FakeAuthenticator()
    client = new_client()
    info = sign_up(client, email, authenticator)
    second = register_passkey(client, authenticator, label="MacBook passkey")
    assert len(client.get("/api/security/passkeys").json()) == 2

    # Active but the last passkey check is stale: unlocked, yet step-up is required
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET passkey_verified_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": info["session_id"]},
        )
    assert client.get("/api/auth/session").json()["locked"] is False
    r = client.delete(f"/api/security/passkeys/{second['id']}")
    assert r.status_code == 403
    assert r.json() == {"detail": "step_up_required"}

    assert_passkey(client, authenticator, purpose="step_up")
    assert client.delete(f"/api/security/passkeys/{second['id']}").status_code == 204
    assert outbox()[-1].subject == "A passkey was removed"
    remaining = client.get("/api/security/passkeys").json()
    assert len(remaining) == 1
    r = client.delete(f"/api/security/passkeys/{remaining[0]['id']}")
    assert r.status_code == 409
    assert r.json() == {"detail": "last_passkey"}


def test_two_removals_at_once_never_take_the_last_passkey() -> None:
    """Invariant: the last passkey stays (409 last_passkey), even when two removals race
    (October 28, 2026). Both counted 2 and both deleted, leaving none. Two connections: the
    first holds the person's row, as a removal in flight does, and deletes passkey one; the
    route removing passkey two must wait for it and then count what is left."""
    import threading

    from sqlalchemy import delete, select

    from app.models.user import User
    from app.models.webauthn_credential import WebauthnCredential

    authenticator = FakeAuthenticator()
    client = new_client()
    info = sign_up(client, _email(), authenticator)
    register_passkey(client, authenticator, label="MacBook passkey")
    first, second = client.get("/api/security/passkeys").json()
    uid = uuid.UUID(info["user"]["id"])
    answers: list[int] = []
    with get_session_factory()() as other:
        other.execute(select(User.id).where(User.id == uid).with_for_update())
        other.execute(
            delete(WebauthnCredential).where(WebauthnCredential.id == uuid.UUID(first["id"]))
        )
        worker = threading.Thread(
            target=lambda: answers.append(
                client.delete(f"/api/security/passkeys/{second['id']}").status_code
            )
        )
        worker.start()
        worker.join(timeout=1.5)  # waits for the person's row while the first removal runs
        other.commit()
    worker.join(timeout=10)
    assert answers == [409]
    assert len(client.get("/api/security/passkeys").json()) == 1


def test_adding_another_passkey_needs_an_unlocked_session_and_a_fresh_check() -> None:
    """A stolen cookie, locked or not, must not enrol its own passkey and come out unlocked."""
    email = _email()
    authenticator = FakeAuthenticator()
    client = new_client()
    info = sign_up(client, email, authenticator)  # the first passkey needs only the email code
    attacker = FakeAuthenticator()

    _age_session(info["session_id"], minutes=6)  # locked
    r = client.post("/api/security/passkeys/register/options")
    assert r.status_code == 403 and r.json() == {"detail": "locked"}

    assert_passkey(client, authenticator)  # unlocked, then the check goes stale
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET passkey_verified_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": info["session_id"]},
        )
    assert client.get("/api/auth/session").json()["locked"] is False
    r = client.post("/api/security/passkeys/register/options")
    assert r.status_code == 403 and r.json() == {"detail": "step_up_required"}
    # Options taken while fresh are no use once the check is stale: verify checks again.
    assert_passkey(client, authenticator, purpose="step_up")
    options = client.post("/api/security/passkeys/register/options").json()["options"]
    with get_session_factory()() as db, db.begin():
        db.execute(
            text(
                "UPDATE sessions SET passkey_verified_at = now() - interval '10 minutes' "
                "WHERE id = :id"
            ),
            {"id": info["session_id"]},
        )
    body = {"credential": attacker.register(options)}
    r = client.post("/api/security/passkeys/register/verify", json=body)
    assert r.status_code == 403 and r.json() == {"detail": "step_up_required"}
    assert len(client.get("/api/security/passkeys").json()) == 1

    assert_passkey(client, authenticator, purpose="step_up")
    register_passkey(client, attacker, label="Second device")
    assert len(client.get("/api/security/passkeys").json()) == 2


def test_sign_out_revokes_this_device() -> None:
    email = _email()
    client = new_client()
    sign_up(client, email, FakeAuthenticator())
    r = client.post("/api/auth/signout")
    assert r.status_code == 200
    assert r.json()["authenticated"] is False
    assert client.get("/api/auth/session").json()["authenticated"] is False


def test_tampered_assertion_is_rejected() -> None:
    email = _email()
    client = new_client()
    good = FakeAuthenticator()
    sign_up(client, email, good)
    r = client.post("/api/security/passkeys/assert/options", json={"purpose": "unlock"})
    options = r.json()["options"]
    credential = good.assert_(options)
    credential["response"]["signature"] = credential["response"]["signature"][:-4] + "AAAA"
    r = client.post("/api/security/passkeys/assert/verify", json={"credential": credential})
    assert r.status_code == 400
    assert r.json() == {"detail": "invalid_credential"}
    # the challenge was consumed; a replay with a fresh signature needs new options
    credential = good.assert_(options)
    assert (
        client.post(
            "/api/security/passkeys/assert/verify", json={"credential": credential}
        ).status_code
        == 400
    )


def test_cross_site_posts_are_refused() -> None:
    client = new_client()
    r = client.post(
        "/api/auth/otp/send", json={"email": _email()}, headers={"sec-fetch-site": "cross-site"}
    )
    assert r.status_code == 403
    r = client.post(
        "/api/auth/otp/send", json={"email": _email()}, headers={"origin": "https://evil.example"}
    )
    assert r.status_code == 403
    r = client.post(
        "/api/auth/otp/send", json={"email": _email()}, headers={"origin": "http://localhost:5173"}
    )
    assert r.status_code == 200


def test_session_endpoint_is_never_an_error() -> None:
    client = new_client()
    r = client.get("/api/auth/session")
    assert r.status_code == 200
    body = r.json()
    assert body["authenticated"] is False
    assert body["lock_after_seconds"] == 300
    assert body["step_up_max_age_seconds"] == 300


LOCKED_SUBJECT = "Several wrong codes were tried for your account"


def test_code_checks_are_limited_per_ip_across_addresses() -> None:
    """October 24, 2026: one IP can't spray guesses or lockouts across many addresses."""
    sprayer = new_client()
    for i in range(20):
        r = sprayer.post(
            "/api/auth/otp/verify", json={"email": f"s{i}-{_email()}", "code": "000000"}
        )
        assert r.status_code == 400, r.text  # no code for that address: a normal refusal
    r = sprayer.post("/api/auth/otp/verify", json={"email": _email(), "code": "000000"})
    assert r.status_code == 429 and r.json() == {"detail": "rate_limited"}
    assert int(r.headers["retry-after"]) > 0
    # Another network signs in as usual
    email = _email()
    sign_in_with_code(new_client(), email)


def test_a_lockout_emails_the_account_owner_once() -> None:
    email = _email()
    sign_up(new_client(), email, FakeAuthenticator())
    attacker = new_client()
    send_code(attacker, email)
    outbox().clear()
    for _ in range(4):
        r = attacker.post("/api/auth/otp/verify", json={"email": email, "code": "000000"})
        assert r.status_code == 400
    assert outbox() == []
    r = attacker.post("/api/auth/otp/verify", json={"email": email, "code": "000000"})
    assert r.status_code == 423 and r.json()["detail"] == "locked"
    assert [(m.to, m.subject) for m in outbox()] == [(email, LOCKED_SUBJECT)]
    assert "passkey still signs you in" in outbox()[-1].text
    assert "sign out the device" not in outbox()[-1].text
    # Further tries while locked don't email again
    r = attacker.post("/api/auth/otp/verify", json={"email": email, "code": "000000"})
    assert r.status_code == 423
    assert len(outbox()) == 1


def test_a_lockout_on_an_address_with_no_account_emails_nobody() -> None:
    email = _email()
    client = new_client()
    send_code(client, email)
    outbox().clear()
    for _ in range(5):
        client.post("/api/auth/otp/verify", json={"email": email, "code": "000000"})
    assert outbox() == []
