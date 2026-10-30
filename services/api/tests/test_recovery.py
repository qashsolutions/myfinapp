"""Getting back in without a passkey (owner decision, October 30, 2026; invariant 74).

Someone who lost every passkey signs in with an email code (locked) and asks to get back in:
ready after 24 hours, or at once when their household partner on the same household plan types
the code they read out. Any passkey check by the owner cancels it. The first new passkey removes
the old ones and signs other devices out; an email-only recovery holds the most sensitive
actions for a day.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models.recovery import AccountRecovery
from app.models.user import User
from app.models.webauthn_credential import WebauthnCredential
from tests.auth_flow import (
    assert_passkey,
    new_client,
    outbox,
    register_passkey,
    sign_in_with_code,
    sign_up,
)
from tests.test_household_one_plan import household
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    yield


def _person(name: str):
    client, key = new_client(), FakeAuthenticator()
    email = f"{name.lower()}-{uuid.uuid4().hex[:8]}@example.com"
    sign_up(client, email, key)
    client.patch("/api/account", json={"display_name": name})
    user_id = uuid.UUID(client.get("/api/auth/session").json()["user"]["id"])
    return client, key, email, user_id


def _lost_device(email: str):
    """A new device that only has the email: signed in with a code, locked."""
    client = new_client()
    info = sign_in_with_code(client, email)
    assert info["has_passkeys"] and info["locked"]
    return client


def _subjects(email: str) -> list[str]:
    return [m.subject for m in outbox() if m.to == email]


def _age(user_id: uuid.UUID, hours: float = 24.5) -> None:
    with get_session_factory()() as db:
        for row in db.scalars(select(AccountRecovery).where(AccountRecovery.user_id == user_id)):
            row.ready_at -= timedelta(hours=hours)
            row.expires_at -= timedelta(hours=hours)
        db.commit()


def _passkeys(user_id: uuid.UUID) -> int:
    with get_session_factory()() as db:
        return len(
            db.scalars(
                select(WebauthnCredential).where(WebauthnCredential.user_id == user_id)
            ).all()
        )


def test_email_recovery_waits_a_day_then_a_new_passkey_replaces_the_old() -> None:
    phone, _, email, uid = _person("Asha")
    lost = _lost_device(email)
    assert lost.get("/api/auth/recovery").json()["status"] == "none"
    r = lost.post("/api/auth/recovery")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "waiting"
    assert "Someone asked to get back into your Qash account" in _subjects(email)
    # Asking again changes nothing and sends nothing more
    before = len(_subjects(email))
    assert lost.post("/api/auth/recovery").json()["status"] == "waiting"
    assert len(_subjects(email)) == before
    # Not ready: no passkey can be added without a passkey check
    assert lost.post("/api/security/passkeys/register/options").status_code != 200

    _age(uid)
    assert lost.get("/api/auth/recovery").json()["status"] == "ready"
    register_passkey(lost, FakeAuthenticator())
    assert _passkeys(uid) == 1  # only the new one
    assert "You're back in to Qash" in _subjects(email)
    assert phone.get("/api/auth/session").json()["authenticated"] is False  # signed out
    assert lost.get("/api/auth/session").json()["locked"] is False
    assert lost.get("/api/auth/recovery").json()["status"] == "none"
    # A day's hold on the most sensitive actions, then they open
    assert lost.post("/api/account/export").json()["detail"] == "recently_recovered"
    assert (
        lost.post("/api/account/email/send", json={"new_email": "new@example.com"}).json()["detail"]
        == "recently_recovered"
    )
    with get_session_factory()() as db:
        user = db.get(User, uid)
        assert user is not None and user.recovered_at is not None
        user.recovered_at -= timedelta(hours=25)
        db.commit()
    assert lost.post("/api/account/export").status_code == 200


def test_the_owner_using_a_passkey_cancels_a_recovery_someone_started() -> None:
    phone, key, email, uid = _person("Asha")
    lost = _lost_device(email)
    lost.post("/api/auth/recovery")
    assert_passkey(phone, key)  # the owner opens the app on her phone
    assert "A request to get back in was cancelled" in _subjects(email)
    _age(uid)
    assert lost.get("/api/auth/recovery").json()["status"] == "none"
    assert lost.post("/api/security/passkeys/register/options").status_code != 200
    assert _passkeys(uid) == 1

    # Signing in with a passkey on a new device cancels too
    lost.post("/api/auth/recovery")
    other = new_client()
    r = other.post("/api/auth/passkey/options")
    assert r.status_code == 200, r.text
    credential = key.assert_(r.json()["options"], key.credential_ids[0])
    assert (
        other.post("/api/auth/passkey/verify", json={"credential": credential}).status_code == 200
    )
    assert lost.get("/api/auth/recovery").json()["status"] == "none"


def test_only_a_locked_session_of_an_account_with_passkeys_can_ask() -> None:
    phone, _, email, _ = _person("Asha")
    assert phone.post("/api/auth/recovery").json()["detail"] == "not_needed"  # unlocked
    newcomer = new_client()
    sign_in_with_code(newcomer, f"new-{uuid.uuid4().hex[:6]}@example.com")
    assert newcomer.post("/api/auth/recovery").json()["detail"] == "not_needed"  # no passkeys
    assert new_client().post("/api/auth/recovery").status_code == 401


def test_who_may_cancel() -> None:
    phone, _, email, _ = _person("Asha")
    asking = _lost_device(email)
    asking.post("/api/auth/recovery")
    stranger = _lost_device(email)  # someone else with the email, also locked
    assert stranger.post("/api/auth/recovery/cancel").json()["detail"] == "not_allowed"
    assert asking.post("/api/auth/recovery/cancel").json()["status"] == "none"  # "found it"
    asking.post("/api/auth/recovery")
    assert phone.post("/api/auth/recovery/cancel").json()["status"] == "none"  # the owner


def _couple():
    asha, asha_key, asha_email, asha_id = _person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, ben_key, ben_email, ben_id = _person("Ben")
    household(asha, ben)
    return (asha, asha_key, asha_email, asha_id), (ben, ben_key, ben_email, ben_id)


def test_a_partner_on_the_same_household_plan_approves_at_once() -> None:
    (asha, asha_key, _, _), (ben, _, ben_email, ben_id) = _couple()
    setting = ben.get("/api/account/recovery-partner").json()
    assert setting == {"on": False, "possible": True, "partner_name": "Asha"}
    r = ben.put("/api/account/recovery-partner", json={"on": True})
    assert r.status_code == 200, r.text
    assert r.json()["on"] is True

    lost = _lost_device(ben_email)
    assert lost.get("/api/auth/recovery").json()["partner_name"] == "Asha"
    r = lost.post("/api/auth/recovery/partner")
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    assert r.json()["partner_name"] == "Asha"

    asked = asha.get("/api/household/recovery").json()
    assert [a["name"] for a in asked] == ["Ben"]
    assert_passkey(asha, asha_key, purpose="step_up")
    wrong = "000000" if code != "000000" else "111111"
    assert asha.post("/api/household/recovery/approve", json={"code": wrong}).status_code == 400
    assert asha.post("/api/household/recovery/approve", json={"code": code}).status_code == 200
    assert asha.get("/api/household/recovery").json() == []

    # Ready for the device Ben is holding only, not another one signed in with his email
    other = _lost_device(ben_email)
    assert other.get("/api/auth/recovery").json()["status"] == "waiting"
    assert other.post("/api/security/passkeys/register/options").status_code != 200
    assert lost.get("/api/auth/recovery").json()["status"] == "ready"
    register_passkey(lost, FakeAuthenticator())
    assert _passkeys(ben_id) == 1
    assert ben.get("/api/auth/session").json()["authenticated"] is False
    # No day's hold: his partner vouched for him
    with get_session_factory()() as db:
        user = db.get(User, ben_id)
        assert user is not None and user.recovered_at is None


def test_no_partner_unless_both_are_on_the_households_one_plan() -> None:
    ben, _, ben_email, _ = _person("Ben")
    # No household: nothing to turn on
    assert ben.get("/api/account/recovery-partner").json()["possible"] is False
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 409

    (asha, _, _, _), (ben, _, ben_email, _) = _couple()
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 200
    # The household splits: Asha is no longer his partner on one plan
    assert asha.post("/api/household/leave").status_code in (200, 204)
    lost = _lost_device(ben_email)
    assert lost.get("/api/auth/recovery").json()["partner_name"] is None
    assert lost.post("/api/auth/recovery/partner").json()["detail"] == "no_partner"


def test_not_opted_in_means_no_partner_route() -> None:
    _, (ben, _, ben_email, _) = _couple()
    lost = _lost_device(ben_email)
    assert lost.get("/api/auth/recovery").json()["partner_name"] is None
    assert lost.post("/api/auth/recovery/partner").json()["detail"] == "no_partner"


def test_a_request_closes_after_its_week_to_finish() -> None:
    _, _, email, uid = _person("Asha")
    lost = _lost_device(email)
    lost.post("/api/auth/recovery")
    _age(uid, hours=24 + 7 * 24 + 1)
    assert lost.get("/api/auth/recovery").json()["status"] == "none"
    with get_session_factory()() as db:
        row = db.scalars(select(AccountRecovery).where(AccountRecovery.user_id == uid)).one()
        assert (row.status, row.closed_reason) == ("cancelled", "expired")
