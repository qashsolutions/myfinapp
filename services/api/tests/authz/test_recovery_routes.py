"""Getting back in (invariant 74): only the partner the request names can see or approve it,
and nobody's cancel or status reaches another account's request."""

import uuid

import pytest

from tests.auth_flow import assert_passkey, new_client, outbox, sign_in_with_code, sign_up
from tests.test_household_one_plan import household
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


def _person(name: str):
    client, key = new_client(), FakeAuthenticator()
    email = f"{name.lower()}+{uuid.uuid4().hex[:6]}@example.com"
    sign_up(client, email, key)
    client.patch("/api/account", json={"display_name": name})
    return client, key, email


def test_cross_user_recovery() -> None:
    asha, _, _ = _person("Asha")
    assert asha.post("/api/billing/trial", json={"plan": "connected"}).status_code == 200
    ben, _, ben_email = _person("Ben")
    household(asha, ben)
    assert ben.put("/api/account/recovery-partner", json={"on": True}).status_code == 200
    carol, carol_key, _ = _person("Carol")

    lost = new_client()
    sign_in_with_code(lost, ben_email)
    code = lost.post("/api/auth/recovery/partner").json()["code"]

    # Carol, even holding the code, sees nothing and approves nothing
    assert carol.get("/api/household/recovery").json() == []
    assert_passkey(carol, carol_key, purpose="step_up")
    r = carol.post("/api/household/recovery/approve", json={"code": code})
    assert r.status_code == 404
    # Her own cancel and status touch only her account
    assert carol.post("/api/auth/recovery/cancel").json()["status"] == "none"
    assert carol.get("/api/auth/recovery").json()["status"] == "none"
    assert lost.get("/api/auth/recovery").json()["status"] == "waiting"
    # Asha still sees Ben's request
    assert [a["name"] for a in asha.get("/api/household/recovery").json()] == ["Ben"]
