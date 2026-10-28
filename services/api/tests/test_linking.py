"""Read-only linking (chunk 3.2): step-up, plan cap, Hosted Link, sealed tokens, disconnect."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.linking import plaid, token_vault
from app.models.audit_log import AuditLog
from app.models.linking import BankConnection, LinkSession
from tests.auth_flow import new_client, outbox, sign_up
from tests.billing_helpers import grant_plan
from tests.plaid_fake import FakePlaid
from tests.webauthn_fake import FakeAuthenticator


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()
    plaid.transport_override = None
    yield
    plaid.transport_override = None


@pytest.fixture
def fake() -> FakePlaid:
    f = FakePlaid()
    plaid.transport_override = f.transport()
    return f


def member(name: str, plan: str | None = "connected"):
    client = new_client()
    user_id = sign_up(client, f"{name}+{uuid.uuid4().hex[:6]}@example.com", FakeAuthenticator())[
        "user"
    ]["id"]
    if plan:
        grant_plan(user_id, plan)
    return client, user_id


def start(client, fake: FakePlaid, *institutions: str) -> str:
    r = client.post("/api/linking/start", headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 200, r.text
    session_id = r.json()["session_id"]
    assert r.json()["url"].startswith("https://hosted.plaid.example/")
    link_token = fake.bodies("/link/token/create") and fake.requests[-1]
    token = r.json()["url"].rsplit("/", 1)[-1]
    if institutions:
        fake.link(token, *institutions)
    assert link_token
    return session_id


def test_link_requests_read_only_products_and_seals_the_token(fake: FakePlaid) -> None:
    client, user_id = member("maya")
    status = client.get("/api/linking").json()
    assert status == {"available": True, "max_connections": 3, "connections": []}

    session_id = start(client, fake, "First Platypus Bank")
    create = fake.bodies("/link/token/create")[-1]
    assert create["products"] == ["transactions"]
    assert create["optional_products"] == ["liabilities"]
    assert create["hosted_link"]["completion_redirect_uri"] == (
        f"http://localhost:5173/me/linking/done?session={session_id}"
    )
    assert user_id not in create["user"]["client_user_id"]  # a pseudonym, never our id or email
    assert "@" not in create["user"]["client_user_id"]
    for _, _, headers in fake.requests:
        assert headers["PLAID-SECRET"] == "test-plaid-secret"

    r = client.post("/api/linking/finish", json={"session_id": session_id})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "linked"
    [conn] = out["connections"]
    assert conn["institution_name"] == "First Platypus Bank"
    assert [a["mask"] for a in conn["accounts"]] == ["0000", "3333"]
    assert "balances" not in str(out)  # balances are dropped at the provider boundary

    with get_session_factory()() as db:
        row = db.scalar(select(BankConnection).where(BankConnection.user_id == uuid.UUID(user_id)))
        assert row is not None
        assert "access-sandbox" not in row.access_token_encrypted
        assert token_vault.open_(row.access_token_encrypted).startswith("access-sandbox-")
        assert row.key_id == token_vault.key_id()
        actions = db.scalars(
            select(AuditLog.action).where(AuditLog.actor_id == uuid.UUID(user_id))
        ).all()
        assert "bank_connected" in actions
    assert any(m.subject == "A bank was connected" for m in outbox())

    # The session finishes once.
    assert client.post("/api/linking/finish", json={"session_id": session_id}).status_code == 409
    listed = client.get("/api/linking").json()["connections"]
    assert [c["institution_name"] for c in listed] == ["First Platypus Bank"]
    assert "accounts" not in listed[0]  # the server keeps no account list


def test_leaving_without_linking_is_cancelled(fake: FakePlaid) -> None:
    client, _ = member("maya")
    session_id = start(client, fake)
    r = client.post("/api/linking/finish", json={"session_id": session_id})
    assert r.json() == {
        "status": "cancelled",
        "connections": [],
        "already_linked": [],
        "failed": [],
    }
    assert client.get("/api/linking").json()["connections"] == []


def test_plan_caps_connections(fake: FakePlaid) -> None:
    free, _ = member("fran", plan=None)
    assert client_post_start(free).status_code == 403
    assert client_post_start(free).json()["detail"] == "plan_limit"

    client, _ = member("maya")
    session_id = start(client, fake, "Bank A", "Bank B", "Bank C", "Bank D")
    out = client.post("/api/linking/finish", json={"session_id": session_id}).json()
    assert len(out["connections"]) == 3
    # The fourth is never exchanged: no access token, so no item Plaid bills for.
    assert len(fake.bodies("/item/public_token/exchange")) == 3
    assert fake.removed == []
    assert client_post_start(client).json()["detail"] == "plan_limit"


def _finish_while_another_holds_the_person(client, user_id: str, session_id: str, meanwhile):
    """Two connections (October 28, 2026): the other holds the person's row, as a finish in
    flight does, and does `meanwhile` there; the route runs on a thread and must wait for it."""
    import threading

    from app.models.user import User

    answers: list = []
    with get_session_factory()() as other:
        other.execute(select(User.id).where(User.id == uuid.UUID(user_id)).with_for_update())
        meanwhile(other)
        worker = threading.Thread(
            target=lambda: answers.append(
                client.post("/api/linking/finish", json={"session_id": session_id})
            )
        )
        worker.start()
        worker.join(timeout=1.5)
        other.commit()
    worker.join(timeout=10)
    [r] = answers
    return r


def test_two_finishes_of_one_session_link_once(fake: FakePlaid) -> None:
    """Invariant: a link session finishes once (409 session_used), even when two arrive at
    once; before, both exchanged the token and Plaid billed two items."""
    client, user_id = member("twice")
    session_id = start(client, fake, "Bank A")

    def finished(other) -> None:
        row = other.get(LinkSession, uuid.UUID(session_id), with_for_update=True)
        row.finished_at = datetime.now(UTC)

    r = _finish_while_another_holds_the_person(client, user_id, session_id, finished)
    assert (r.status_code, r.json()["detail"]) == (409, "session_used")
    assert fake.bodies("/item/public_token/exchange") == []


def test_two_sessions_with_one_place_left_make_one_link(fake: FakePlaid) -> None:
    """Invariant: the plan's bank_links_max holds under concurrency (October 28, 2026)."""
    client, user_id = member("lastplace")
    first = start(client, fake, "Bank A", "Bank B")
    assert (
        len(client.post("/api/linking/finish", json={"session_id": first}).json()["connections"])
        == 2
    )
    second = start(client, fake, "Bank C")

    def third_link(other) -> None:  # the other session's finish takes the last place
        other.add(
            BankConnection(
                user_id=uuid.UUID(user_id),
                provider="plaid",
                item_id=f"item-{uuid.uuid4().hex}",
                institution_name="Bank D",
                last_used_at=datetime.now(UTC),
                access_token_encrypted=token_vault.seal("access-sandbox-other"),
                key_id=token_vault.key_id(),
            )
        )

    r = _finish_while_another_holds_the_person(client, user_id, second, third_link)
    assert (r.status_code, r.json()["detail"]) == (403, "plan_limit")
    assert len(client.get("/api/linking").json()["connections"]) == 3


def test_a_bank_already_connected_is_never_exchanged_again(fake: FakePlaid) -> None:
    client, user_id = member("maya")
    first = start(client, fake, "First Platypus Bank")
    assert client.post("/api/linking/finish", json={"session_id": first}).json()["status"] == (
        "linked"
    )
    exchanges = len(fake.bodies("/item/public_token/exchange"))
    alerts = len(outbox())

    again = start(client, fake, "First Platypus Bank")
    r = client.post("/api/linking/finish", json={"session_id": again})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "status": "already_linked",
        "connections": [],
        "already_linked": ["First Platypus Bank"],
        "failed": [],
    }
    assert len(fake.bodies("/item/public_token/exchange")) == exchanges  # Plaid's guidance
    assert len(outbox()) == alerts  # nothing new was connected
    assert len(client.get("/api/linking").json()["connections"]) == 1

    # In one trip: the new bank links, the one already connected does not.
    both = start(client, fake, "First Platypus Bank", "Second Bank")
    out = client.post("/api/linking/finish", json={"session_id": both}).json()
    assert out["status"] == "linked"
    assert [c["institution_name"] for c in out["connections"]] == ["Second Bank"]
    assert out["already_linked"] == ["First Platypus Bank"]

    # Another person linking the same bank is not a duplicate.
    other, _ = member("lee")
    theirs = start(other, fake, "First Platypus Bank")
    assert other.post("/api/linking/finish", json={"session_id": theirs}).json()["status"] == (
        "linked"
    )


def test_a_disconnected_bank_can_be_linked_afresh(fake: FakePlaid) -> None:
    client, _ = member("maya")
    first = start(client, fake, "First Platypus Bank")
    conn = client.post("/api/linking/finish", json={"session_id": first}).json()["connections"][0]
    assert client.delete(f"/api/linking/{conn['id']}").status_code == 204
    again = start(client, fake, "First Platypus Bank")
    out = client.post("/api/linking/finish", json={"session_id": again}).json()
    assert out["status"] == "linked"


def _sealed_tokens(user_id: str) -> dict[str, str]:
    """access token -> status, for every connection row the person has."""
    with get_session_factory()() as db:
        rows = db.scalars(
            select(BankConnection).where(BankConnection.user_id == uuid.UUID(user_id))
        ).all()
        return {token_vault.open_(r.access_token_encrypted): r.status for r in rows}


def _no_orphaned_token(fake: FakePlaid, user_id: str) -> None:
    """Every access token Plaid issued is revoked there or sealed in a row of ours."""
    sealed = _sealed_tokens(user_id)
    for token in fake.access_tokens():
        assert token in fake.removed or token in sealed, token


def test_a_failed_account_read_after_the_exchange_never_orphans_the_token(fake: FakePlaid) -> None:
    """Plaid bills an item while its access token lives: a token we hold is sealed in a row or
    revoked at once, never dropped (docs/security/linking.md)."""
    client, user_id = member("maya")
    fake.accounts_error, fake.accounts_failures = "INTERNAL_SERVER_ERROR", 1
    session_id = start(client, fake, "First Platypus Bank")
    r = client.post("/api/linking/finish", json={"session_id": session_id})
    assert r.status_code == 502
    assert len(fake.access_tokens()) == 1
    _no_orphaned_token(fake, user_id)
    assert fake.removed == fake.access_tokens()  # revoked at once
    assert client.get("/api/linking").json()["connections"] == []
    # The person can link again straight away
    again = start(client, fake, "First Platypus Bank")
    assert client.post("/api/linking/finish", json={"session_id": again}).json()["status"] == (
        "linked"
    )


def test_when_the_revoke_fails_too_the_token_is_sealed_for_the_retry_job(fake: FakePlaid) -> None:
    client, user_id = member("maya")
    fake.accounts_error, fake.accounts_failures = "INTERNAL_SERVER_ERROR", 1
    fake.fail_remove = True
    session_id = start(client, fake, "First Platypus Bank")
    assert client.post("/api/linking/finish", json={"session_id": session_id}).status_code == 502
    [token] = fake.access_tokens()
    assert _sealed_tokens(user_id) == {token: "revoke_pending"}  # stackd-api revoke-links retries
    assert client.get("/api/linking").json()["connections"] == []  # gone, as far as they know
    fake.fail_remove = False
    assert client_post_start(client).status_code == 200  # never counted against the plan
    from app.jobs.link_revoke import revoke_due

    with get_session_factory()() as db:
        assert revoke_due(db)["pending_revoked"] >= 1
    assert token in fake.removed and _sealed_tokens(user_id) == {}


def test_one_bank_failing_keeps_the_others_it_linked(fake: FakePlaid) -> None:
    client, user_id = member("maya")
    session_id = start(client, fake, "Bank A", "Bank B")
    fake.accounts_error = "INTERNAL_SERVER_ERROR"
    # Bank A reads fine; Bank B's account read fails (the second /accounts/get call)
    calls = {"n": 0}
    transport = fake.transport()

    def handle(request):
        if request.url.path == "/accounts/get":
            calls["n"] += 1
            fake.accounts_failures = 1 if calls["n"] == 2 else 0
        return transport.handle_request(request)

    import httpx2

    plaid.transport_override = httpx2.MockTransport(handle)
    r = client.post("/api/linking/finish", json={"session_id": session_id})
    assert r.status_code == 200, r.text
    out = r.json()
    assert [c["institution_name"] for c in out["connections"]] == ["Bank A"]
    assert out["failed"] == ["Bank B"]
    _no_orphaned_token(fake, user_id)
    assert [c["institution_name"] for c in client.get("/api/linking").json()["connections"]] == [
        "Bank A"
    ]


def test_an_item_someone_else_holds_is_revoked_even_when_plaid_is_down(fake: FakePlaid) -> None:
    other, _ = member("lee")
    theirs = start(other, fake, "First Platypus Bank")
    [conn] = other.post("/api/linking/finish", json={"session_id": theirs}).json()["connections"]
    with get_session_factory()() as db:
        item_id = db.get(BankConnection, uuid.UUID(conn["id"])).item_id

    client, user_id = member("maya")
    session_id = start(client, fake, "First Platypus Bank")
    fake.item_id = item_id
    fake.fail_remove = True
    r = client.post("/api/linking/finish", json={"session_id": session_id})
    assert r.status_code == 502, r.text  # never a 500, and nothing of theirs is touched
    assert _sealed_tokens(user_id) == {}
    assert len(other.get("/api/linking").json()["connections"]) == 1


def test_plaid_errors_log_the_request_id_and_nothing_else(
    fake: FakePlaid, caplog: pytest.LogCaptureFixture
) -> None:
    fake.sync_error = "ITEM_LOGIN_REQUIRED"
    fake.error_extra = {
        "error_type": "ITEM_ERROR",
        "error_message": "the login details of this item have changed at First Platypus Bank",
        "request_id": "Req-abc123",
    }
    with caplog.at_level("WARNING", logger="stackd.plaid"):
        with pytest.raises(plaid.LinkError):
            plaid.transactions_sync("access-sandbox-x", None)
    text = caplog.text
    assert "request_id=Req-abc123" in text
    assert "error_code=ITEM_LOGIN_REQUIRED" in text and "error_type=ITEM_ERROR" in text
    assert "Platypus" not in text and "access-sandbox" not in text


def client_post_start(client):
    return client.post("/api/linking/start", headers={"Origin": "http://localhost:5173"})


def test_disconnect_revokes_at_the_provider_then_deletes(fake: FakePlaid) -> None:
    client, user_id = member("maya")
    session_id = start(client, fake, "First Platypus Bank")
    [conn] = client.post("/api/linking/finish", json={"session_id": session_id}).json()[
        "connections"
    ]
    outbox().clear()

    # (A provider outage during Disconnect is chunk 3.4's case: tests/test_linking_revoke.py.)
    assert client.delete(f"/api/linking/{conn['id']}").status_code == 204
    assert fake.removed and fake.removed[-1].startswith("access-sandbox-")
    assert client.get("/api/linking").json()["connections"] == []
    assert any(m.subject == "A bank was disconnected" for m in outbox())


def test_expired_session_is_refused(fake: FakePlaid) -> None:
    client, _ = member("maya")
    session_id = start(client, fake, "First Platypus Bank")
    with get_session_factory()() as db, db.begin():
        row = db.get(LinkSession, uuid.UUID(session_id))
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    assert client.post("/api/linking/finish", json={"session_id": session_id}).status_code == 410


def test_account_deletion_revokes_every_connection(fake: FakePlaid) -> None:
    client, user_id = member("maya")
    session_id = start(client, fake, "Bank A", "Bank B")
    client.post("/api/linking/finish", json={"session_id": session_id})
    assert client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code in (200, 204)
    assert len(fake.removed) == 2
    with get_session_factory()() as db:
        assert (
            db.scalar(select(BankConnection).where(BankConnection.user_id == uuid.UUID(user_id)))
            is None
        )


def test_linking_is_off_without_a_provider() -> None:
    client, _ = member("maya")
    from app.config import get_settings

    settings = get_settings()
    saved = settings.plaid_secret
    settings.plaid_secret = None
    try:
        assert client.get("/api/linking").json()["available"] is False
        assert client_post_start(client).status_code == 503
    finally:
        settings.plaid_secret = saved
