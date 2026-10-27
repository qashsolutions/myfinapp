"""Card details (chunk 3.5): the issuer's statement facts pass through to the device and are
never kept; an item without card data answers empty; a sign-in problem is flagged."""

import pytest
from sqlalchemy import inspect

from app.db import get_engine
from app.linking import plaid
from tests.auth_flow import outbox
from tests.plaid_fake import FakePlaid
from tests.test_linking_revoke import linked, row


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


def test_card_facts_pass_through(fake: FakePlaid) -> None:
    client, _, conn_id, access = linked(fake)
    r = client.post(f"/api/linking/{conn_id}/cards")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "cards": [
            {
                "account_id": "acc-cc",
                "statement_balance_cents": 41200,  # 412.005 rounds half-even
                "statement_date": "2026-10-01",
                "due_date": "2026-10-28",
                "minimum_cents": 2500,
                "last_payment_cents": 16837,
                "last_payment_date": "2026-09-16",
                "limit_cents": 200000,
                "apr_bps": 2499,  # the purchase APR, not the cash APR
                "is_overdue": False,
            }
        ]
    }
    assert fake.bodies("/liabilities/get") == [{"access_token": access}]
    # Nothing about the card is stored: no table has a column for it.
    columns = {
        c["name"]
        for t in inspect(get_engine()).get_table_names()
        for c in inspect(get_engine()).get_columns(t)
    }
    assert not {"statement_balance_cents", "apr_bps", "due_date", "limit_cents"} & columns


def test_an_item_without_card_data_answers_empty(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    fake.liabilities_error = "NO_LIABILITY_ACCOUNTS"
    assert client.post(f"/api/linking/{conn_id}/cards").json() == {"cards": []}


def test_a_sign_in_problem_is_flagged(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    fake.liabilities_error = "ITEM_LOGIN_REQUIRED"
    r = client.post(f"/api/linking/{conn_id}/cards")
    assert r.status_code == 409 and r.json()["detail"] == "login_required"
    pending = row(conn_id)
    assert pending is not None and pending.status == "login_required"


def test_provider_outage_is_a_bad_gateway(fake: FakePlaid) -> None:
    client, _, conn_id, _ = linked(fake)
    fake.liabilities_error = "INTERNAL_SERVER_ERROR"
    assert client.post(f"/api/linking/{conn_id}/cards").status_code == 502
