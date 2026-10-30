"""Getting back in without a passkey (owner decision, October 30, 2026; invariant 74).

Someone who lost every passkey signs in with an email code (locked) and asks to get back in:
ready after 24 hours, or at once when their household partner on the same household plan types
the code they read out. Any passkey check by the owner cancels it. The first new passkey removes
the old ones and signs other devices out; an email-only recovery holds the most sensitive
actions for a day.
"""

from __future__ import annotations

import threading
import uuid
from datetime import UTC, datetime, timedelta

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
    assert lost.get("/api/auth/recovery").json()["partner_available"] is True
    r = lost.post("/api/auth/recovery/partner")
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    assert "Your household partner was asked to let you back in" in _subjects(ben_email)

    asked = asha.get("/api/household/recovery").json()
    assert [a["name"] for a in asked] == ["Ben"]
    assert_passkey(asha, asha_key, purpose="step_up")
    wrong = "000000" if code != "000000" else "111111"
    assert asha.post("/api/household/recovery/approve", json={"code": wrong}).status_code == 400
    assert asha.post("/api/household/recovery/approve", json={"code": code}).status_code == 200
    assert asha.get("/api/household/recovery").json() == []
    assert "Your household partner let you back in" in _subjects(ben_email)

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
    assert lost.get("/api/auth/recovery").json()["partner_available"] is False
    assert lost.post("/api/auth/recovery/partner").json()["detail"] == "no_partner"


def test_not_opted_in_means_no_partner_route() -> None:
    _, (ben, _, ben_email, _) = _couple()
    lost = _lost_device(ben_email)
    assert lost.get("/api/auth/recovery").json()["partner_available"] is False
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


# --- From the independent review (October 30, 2026) -------------------------------------------


def _waiting_rows(uid: uuid.UUID) -> int:
    with get_session_factory()() as db:
        return len(
            db.scalars(
                select(AccountRecovery).where(
                    AccountRecovery.user_id == uid, AccountRecovery.status == "waiting"
                )
            ).all()
        )


def test_requests_sent_at_once_make_one_and_the_owners_passkey_ends_it() -> None:
    phone, key, email, uid = _person("Asha")
    devices = [_lost_device(email) for _ in range(4)]
    barrier = threading.Barrier(len(devices))

    def go(client) -> None:
        barrier.wait()
        client.post("/api/auth/recovery")

    threads = [threading.Thread(target=go, args=(c,)) for c in devices]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert _waiting_rows(uid) == 1
    assert_passkey(phone, key)  # the owner unlocks once
    assert _waiting_rows(uid) == 0
    _age(uid)
    for c in devices:
        assert c.get("/api/auth/recovery").json()["status"] == "none"
        assert c.post("/api/security/passkeys/register/options").status_code != 200


def test_an_approval_never_moves_to_another_session() -> None:
    (asha, asha_key, _, _), (ben, _, ben_email, ben_id) = _couple()
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 200
    lost = _lost_device(ben_email)
    code = lost.post("/api/auth/recovery/partner").json()["code"]
    assert_passkey(asha, asha_key, purpose="step_up")
    assert asha.post("/api/household/recovery/approve", json={"code": code}).status_code == 200
    # Someone else with Ben's email asks the partner again: a new code, and the approval is
    # gone; their session is not let in
    attacker = _lost_device(ben_email)
    assert attacker.post("/api/auth/recovery/partner").status_code == 200
    assert attacker.get("/api/auth/recovery").json()["status"] == "waiting"
    assert attacker.post("/api/security/passkeys/register/options").status_code != 200
    assert lost.get("/api/auth/recovery").json()["status"] == "waiting"  # Ben asks again
    assert _passkeys(ben_id) == 1
    # And after the 24 hours, whoever finishes without the partner's approval gets the hold
    _age(ben_id)
    register_passkey(attacker, FakeAuthenticator())
    with get_session_factory()() as db:
        user = db.get(User, ben_id)
        assert user is not None and user.recovered_at is not None


def test_the_owner_using_a_passkey_while_one_is_made_undoes_it(monkeypatch) -> None:
    from app.services import webauthn as webauthn_svc

    phone, key, email, uid = _person("Asha")
    lost = _lost_device(email)
    lost.post("/api/auth/recovery")
    _age(uid)
    real = webauthn_svc.verify_registration

    def owner_unlocks_meanwhile(*args, **kwargs):
        row = real(*args, **kwargs)
        assert_passkey(phone, key)  # the owner unlocks at that moment, in its own transaction
        return row

    monkeypatch.setattr(webauthn_svc, "verify_registration", owner_unlocks_meanwhile)
    r = lost.post("/api/security/passkeys/register/options")
    assert r.status_code == 200, r.text
    credential = FakeAuthenticator().register(r.json()["options"])
    r = lost.post("/api/security/passkeys/register/verify", json={"credential": credential})
    assert r.status_code == 409 and r.json()["detail"] == "recovery_closed"
    assert _passkeys(uid) == 1  # only the owner's
    assert lost.get("/api/auth/session").json()["locked"] is True
    assert phone.get("/api/auth/session").json()["authenticated"] is True


def test_the_choice_of_partner_is_one_person_not_any_household() -> None:
    (asha, _, _, _), (ben, _, ben_email, _) = _couple()
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 200
    assert asha.post("/api/household/leave").status_code in (200, 204)
    ben.post("/api/household/leave")  # a household of one: he leaves it too
    carol, _, _, _ = _person("Carol")
    assert carol.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    household(carol, ben)
    # Carol is Ben's partner now, but he chose Asha: he must choose again
    assert ben.get("/api/account/recovery-partner").json() == {
        "on": False,
        "possible": True,
        "partner_name": "Carol",
    }
    lost = _lost_device(ben_email)
    assert lost.post("/api/auth/recovery/partner").json()["detail"] == "no_partner"


def test_a_device_opened_by_link_with_your_phone_is_never_a_recovery() -> None:
    with get_session_factory()() as db:
        from app.models.session import Session as Row
        from app.services import recovery as recovery_svc

        row = Row(
            user_id=uuid.uuid4(),
            token_hash="x",
            device_label="Chrome on Mac",
            last_seen_at=datetime.now(UTC),
            expires_at=datetime.now(UTC),
            link_unlocked_at=datetime.now(UTC),
        )
        assert recovery_svc.may_add_passkey(db, row.user_id, row) is False


def test_starts_are_counted_per_account_not_only_per_device() -> None:
    _, _, email, _ = _person("Asha")
    for _ in range(3):
        device = _lost_device(email)
        assert device.post("/api/auth/recovery").status_code == 200
        assert device.post("/api/auth/recovery/cancel").status_code == 200
    # A fourth device, a fourth start that would email the owner again: refused
    assert _lost_device(email).post("/api/auth/recovery").status_code == 429


def test_a_partner_code_stops_working_after_five_wrong_tries() -> None:
    (asha, asha_key, _, _), (ben, _, ben_email, _) = _couple()
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 200
    lost = _lost_device(ben_email)
    code = lost.post("/api/auth/recovery/partner").json()["code"]
    assert_passkey(asha, asha_key, purpose="step_up")
    wrong = "000000" if code != "000000" else "111111"
    left = []
    for _ in range(5):
        r = asha.post("/api/household/recovery/approve", json={"code": wrong})
        assert r.status_code == 400
        left.append(r.json()["detail"]["attempts_left"])
    assert left == [4, 3, 2, 1, 0]
    # The right code no longer works; Ben asks again for a new one
    assert asha.post("/api/household/recovery/approve", json={"code": code}).status_code == 404
    assert asha.get("/api/household/recovery").json() == []
    code = lost.post("/api/auth/recovery/partner").json()["code"]
    assert asha.post("/api/household/recovery/approve", json={"code": code}).status_code == 200


# --- From the second review (October 30, 2026) ------------------------------------------------


def test_the_partner_sees_the_device_asking_now() -> None:
    from tests.auth_flow import MAC_UA

    (asha, _, _, _), (ben, _, ben_email, _) = _couple()
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 200
    _lost_device(ben_email).post("/api/auth/recovery")  # started on an iPhone
    other = new_client(MAC_UA)
    sign_in_with_code(other, ben_email)
    assert other.post("/api/auth/recovery/partner").status_code == 200
    [asked] = asha.get("/api/household/recovery").json()
    assert "Mac" in asked["device_label"]


def test_asking_the_partner_never_gives_the_right_to_cancel() -> None:
    (_, _, _, _), (ben, _, ben_email, _) = _couple()
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 200
    owner = _lost_device(ben_email)
    owner.post("/api/auth/recovery")
    other = _lost_device(ben_email)
    assert other.post("/api/auth/recovery/partner").status_code == 200
    assert other.post("/api/auth/recovery/cancel").json()["detail"] == "not_allowed"
    assert owner.get("/api/auth/recovery").json()["status"] == "waiting"
    assert owner.post("/api/auth/recovery/cancel").json()["status"] == "none"  # the starter may


def test_cancelling_after_it_finished_says_nothing() -> None:
    phone, _, email, uid = _person("Asha")
    lost = _lost_device(email)
    lost.post("/api/auth/recovery")
    _age(uid)
    register_passkey(lost, FakeAuthenticator())
    before = _subjects(email)
    assert lost.post("/api/auth/recovery/cancel").json()["status"] == "none"
    assert _subjects(email) == before  # no "cancelled" after "You're back in"


def _race_finish_against_owner() -> None:
    phone, key, email, uid = _person("Asha")
    lost = _lost_device(email)
    lost.post("/api/auth/recovery")
    _age(uid)
    r = lost.post("/api/security/passkeys/register/options")
    assert r.status_code == 200, r.text
    credential = FakeAuthenticator().register(r.json()["options"])
    r = phone.post("/api/security/passkeys/assert/options", json={"purpose": "unlock"})
    assertion = key.assert_(r.json()["options"])
    barrier = threading.Barrier(2)
    codes: dict[str, int] = {}

    def finish() -> None:
        barrier.wait()
        codes["finish"] = lost.post(
            "/api/security/passkeys/register/verify", json={"credential": credential}
        ).status_code

    def owner() -> None:
        barrier.wait()
        codes["owner"] = phone.post(
            "/api/security/passkeys/assert/verify", json={"credential": assertion}
        ).status_code

    threads = [threading.Thread(target=finish), threading.Thread(target=owner)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert 500 not in codes.values(), codes
    # One of the two won, cleanly: the owner (the new passkey undone) or the recovery
    assert _passkeys(uid) == 1
    assert codes["finish"] in (200, 409), codes
    if codes["finish"] == 409:
        assert codes["owner"] == 200


def test_finishing_and_the_owners_passkey_at_once_never_deadlock() -> None:
    for _ in range(3):
        _race_finish_against_owner()


def test_a_passkey_sign_in_racing_a_finish_is_a_plain_unknown_passkey(monkeypatch) -> None:
    """Final review: sign-in read the passkey, then waited on the lock while a recovery removed
    it, and answered 500. It reads it again under the lock."""
    from app.services import account_lock
    from app.services import webauthn as webauthn_svc

    phone, key, email, uid = _person("Asha")
    lost = _lost_device(email)
    lost.post("/api/auth/recovery")
    _age(uid)
    other = new_client()
    r = other.post("/api/auth/passkey/options")
    assertion = key.assert_(r.json()["options"], key.credential_ids[0])
    real = account_lock.lock_account
    done = {"finished": False}

    def finish_first(db, user_id):
        if not done["finished"]:
            done["finished"] = True
            register_passkey(lost, FakeAuthenticator())  # its own transaction, committed
        real(db, user_id)

    monkeypatch.setattr(webauthn_svc, "lock_account", finish_first)
    r = other.post("/api/auth/passkey/verify", json={"credential": assertion})
    assert r.status_code == 400 and r.json()["detail"] == "unknown_credential"
    assert _passkeys(uid) == 1
