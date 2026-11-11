"""The e2e stack's API with Plaid faked (`e2e/start-api.sh`, never production).

The Playwright journeys run on every pull request with no network to Plaid and no Plaid keys,
so the bank-linking journey (apps/web/e2e/linking.spec.ts) runs the real app and API against
`tests/plaid_fake.FakePlaid`, as the API's own linking tests do:

- Linking is switched on with made-up credentials and a fresh vault key, set here before the
  settings load, so even a machine whose .env holds real sandbox keys never reaches Plaid.
- Hosted Link is a page on `hosted.plaid.example` that the journey answers itself; every link
  session links "First Platypus Bank" (Plaid's sandbox bank) with a checking account and a card.
- Each new item's first sync brings three transactions dated today, and its card details are
  due in ten days, so the journey passes on any date.
- `POST /__e2e/plaid/login_required` makes the bank ask for a sign-in again, as Plaid's
  ITEM_LOGIN_REQUIRED does; signing in again through update mode clears it.

Run as `uv run uvicorn tests.e2e_app:app`.
"""

from __future__ import annotations

import json
import os
from datetime import date, timedelta
from urllib.parse import quote

import httpx2
from cryptography.fernet import Fernet

os.environ["STACKD_PLAID_CLIENT_ID"] = "e2e-client"
os.environ["STACKD_PLAID_SECRET"] = "e2e-secret-not-a-real-key"
os.environ["STACKD_PLAID_ENV"] = "sandbox"
os.environ["STACKD_LINK_TOKEN_KEY"] = Fernet.generate_key().decode()
os.environ.pop("STACKD_PLAID_WEBHOOK_URL", None)

from app.linking import plaid  # noqa: E402 - after the settings above
from app.main import create_app  # noqa: E402
from tests.plaid_fake import FakePlaid  # noqa: E402

BANK = "First Platypus Bank"


class E2EPlaid(FakePlaid):
    def transport(self) -> httpx2.MockTransport:
        inner = super().transport()

        def handle(request: httpx2.Request) -> httpx2.Response:
            body = json.loads(request.content or b"{}")
            path = request.url.path
            if path == "/liabilities/get":
                return httpx2.Response(200, json=_liabilities())
            response = inner.handle_request(request)
            data = json.loads(response.read() or b"{}")
            if path == "/link/token/create":
                token = data["link_token"]
                if "access_token" in body:
                    self.sync_error = None  # update mode: the person signs in at the bank again
                else:
                    self.link(token, BANK)
                back = body["hosted_link"]["completion_redirect_uri"]
                data["hosted_link_url"] = (
                    f"https://hosted.plaid.example/link/{token}?return={quote(back, safe='')}"
                )
                return httpx2.Response(200, json=data)
            if path == "/item/public_token/exchange":
                self.queue_sync(data["access_token"], _first_page())
            return httpx2.Response(response.status_code, json=data)

        return httpx2.MockTransport(handle)


def _first_page() -> dict:
    today = date.today().isoformat()
    txn = {"account_id": "acc-chk", "date": today, "pending": False}
    return {
        "added": [
            {**txn, "transaction_id": "e2e-1", "amount": 23.40, "name": "PLATYPUS COFFEE"},
            {**txn, "transaction_id": "e2e-2", "amount": 61.12, "name": "RIVERSIDE GROCERY"},
            {**txn, "transaction_id": "e2e-3", "amount": -1800.00, "name": "ACME PAYROLL"},
        ],
        "accounts": [
            {"account_id": "acc-chk", "type": "depository", "balances": {"current": 2400}},
            {"account_id": "acc-cc", "type": "credit", "balances": {"current": 410}},
        ],
    }


def _liabilities() -> dict:
    today = date.today()
    return {
        "accounts": [
            {"account_id": "acc-cc", "balances": {"current": 410, "limit": 2000}, "type": "credit"}
        ],
        "liabilities": {
            "credit": [
                {
                    "account_id": "acc-cc",
                    "aprs": [{"apr_type": "purchase_apr", "apr_percentage": 24.99}],
                    "is_overdue": False,
                    "last_payment_amount": 168.37,
                    "last_payment_date": (today - timedelta(days=20)).isoformat(),
                    "last_statement_issue_date": (today - timedelta(days=12)).isoformat(),
                    "last_statement_balance": 412.00,
                    "minimum_payment_amount": 25,
                    "next_payment_due_date": (today + timedelta(days=10)).isoformat(),
                }
            ],
            "mortgage": None,
            "student": None,
        },
    }


fake = E2EPlaid()
plaid.transport_override = fake.transport()
app = create_app()


@app.post("/__e2e/plaid/login_required", include_in_schema=False)
def _login_required() -> dict:
    fake.sync_error = "ITEM_LOGIN_REQUIRED"
    return {"ok": True}
