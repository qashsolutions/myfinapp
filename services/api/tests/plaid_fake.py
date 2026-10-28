"""A fake Plaid for the linking tests: answers the calls the API makes, records requests.

Sync pages are scripted per access token (`queue_sync`); webhook keys come from an EC key the
test owns (`signing_key`), so tests can sign webhooks the way Plaid does."""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx2
from cryptography.hazmat.primitives.asymmetric import ec


def _b64url(n: int) -> str:
    import base64

    return base64.urlsafe_b64encode(n.to_bytes(32, "big")).rstrip(b"=").decode()


class FakePlaid:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any], httpx2.Headers]] = []
        self.items: dict[str, dict[str, Any]] = {}  # access_token -> item
        self.sessions: dict[str, list[dict[str, Any]]] = {}  # link_token -> item adds
        self.removed: list[str] = []
        self.fail_remove = False
        self.sync_pages: dict[str, list[dict[str, Any]]] = {}  # access_token -> pages left
        self.accounts_error: str | None = None  # an error_code to answer /accounts/get with
        self.sync_error: str | None = None  # an error_code to answer /transactions/sync with
        self.error_extra: dict[str, Any] = {}  # more fields for that error body
        self.mutation_once = False  # answer the next sync with a pagination mutation error
        self.liabilities_error: str | None = None  # an error_code for /liabilities/get
        self.signing_key = ec.generate_private_key(ec.SECP256R1())
        self.key_expired = False  # Plaid marks a retired key with expired_at
        self.key_id = "kid-test-1"
        self._n = 0

    def link(self, link_token: str, *institutions: str) -> None:
        """Simulate the user linking one item per institution in that session."""
        adds = []
        for name in institutions:
            self._n += 1
            adds.append(
                {
                    "public_token": f"public-sandbox-{self._n}",
                    # Plaid's id per bank: the same name is the same bank here.
                    "institution": {"name": name, "institution_id": "ins_" + name.lower()},
                }
            )
        self.sessions[link_token] = adds

    def queue_sync(self, access_token: str, *pages: dict[str, Any]) -> None:
        """Each page: added / modified / removed / accounts lists and has_more."""
        self.sync_pages.setdefault(access_token, []).extend(pages)

    def access_tokens(self) -> list[str]:
        return list(self.items)

    def bodies(self, path: str) -> list[dict[str, Any]]:
        return [b for p, b, _ in self.requests if p == path]

    def transport(self) -> httpx2.MockTransport:
        def handle(request: httpx2.Request) -> httpx2.Response:
            body = json.loads(request.content or b"{}")
            path = request.url.path
            self.requests.append((path, body, request.headers))
            if path == "/link/token/create":
                self._n += 1
                token = f"link-sandbox-{self._n}"
                return httpx2.Response(
                    200,
                    json={
                        "link_token": token,
                        "hosted_link_url": f"https://hosted.plaid.example/link/{token}",
                        "expiration": "2026-10-11T12:30:00Z",
                    },
                )
            if path == "/link/token/get":
                adds = self.sessions.get(body["link_token"], [])
                return httpx2.Response(
                    200,
                    json={
                        "link_token": body["link_token"],
                        "link_sessions": [{"results": {"item_add_results": adds}}],
                    },
                )
            if path == "/item/public_token/exchange":
                n = uuid.uuid4().hex[:12]  # item ids are unique across Plaid, so across runs here
                access = f"access-sandbox-{n}"
                self.items[access] = {"item_id": f"item-{n}"}
                return httpx2.Response(200, json={"access_token": access, "item_id": f"item-{n}"})
            if path == "/accounts/get":
                if self.accounts_error:
                    return httpx2.Response(400, json={"error_code": self.accounts_error})
                return httpx2.Response(
                    200,
                    json={
                        "accounts": [
                            {
                                "account_id": "acc-chk",
                                "name": "Plaid Checking",
                                "official_name": None,
                                "mask": "0000",
                                "type": "depository",
                                "subtype": "checking",
                                "balances": {"current": 110, "available": 100},
                            },
                            {
                                "account_id": "acc-cc",
                                "name": "Plaid Credit Card",
                                "mask": "3333",
                                "type": "credit",
                                "subtype": "credit card",
                                "balances": {"current": 410, "limit": 2000},
                            },
                        ]
                    },
                )
            if path == "/transactions/sync":
                if self.mutation_once:
                    self.mutation_once = False
                    return httpx2.Response(
                        400, json={"error_code": "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"}
                    )
                if self.sync_error:
                    return httpx2.Response(
                        400, json={"error_code": self.sync_error, **self.error_extra}
                    )
                pages = self.sync_pages.get(body["access_token"], [])
                page = pages.pop(0) if pages else {}
                self._n += 1
                return httpx2.Response(
                    200,
                    json={
                        "added": page.get("added", []),
                        "modified": page.get("modified", []),
                        "removed": page.get("removed", []),
                        "accounts": page.get("accounts", []),
                        "next_cursor": f"cursor-{self._n}",
                        "has_more": page.get("has_more", False),
                        "request_id": "r",
                    },
                )
            if path == "/liabilities/get":
                if self.liabilities_error:
                    return httpx2.Response(400, json={"error_code": self.liabilities_error})
                return httpx2.Response(
                    200,
                    json={
                        "accounts": [
                            {
                                "account_id": "acc-cc",
                                "balances": {"current": 410, "limit": 2000},
                                "type": "credit",
                            }
                        ],
                        "liabilities": {
                            "credit": [
                                {
                                    "account_id": "acc-cc",
                                    "aprs": [
                                        {"apr_type": "cash_apr", "apr_percentage": 29.99},
                                        {"apr_type": "purchase_apr", "apr_percentage": 24.99},
                                    ],
                                    "is_overdue": False,
                                    "last_payment_amount": 168.37,
                                    "last_payment_date": "2026-09-16",
                                    "last_statement_issue_date": "2026-10-01",
                                    "last_statement_balance": 412.005,
                                    "minimum_payment_amount": 25,
                                    "next_payment_due_date": "2026-10-28",
                                }
                            ],
                            "mortgage": None,
                            "student": None,
                        },
                    },
                )
            if path == "/webhook_verification_key/get":
                if body.get("key_id") != self.key_id:
                    return httpx2.Response(400, json={"error_code": "INVALID_KEY_ID"})
                numbers = self.signing_key.public_key().public_numbers()
                return httpx2.Response(
                    200,
                    json={
                        "key": {
                            "alg": "ES256",
                            "crv": "P-256",
                            "kid": self.key_id,
                            "kty": "EC",
                            "use": "sig",
                            "x": _b64url(numbers.x),
                            "y": _b64url(numbers.y),
                            "expired_at": 1700000000 if self.key_expired else None,
                        }
                    },
                )
            if path == "/item/remove":
                if self.fail_remove:
                    return httpx2.Response(500, json={"error_code": "INTERNAL_SERVER_ERROR"})
                self.removed.append(body["access_token"])
                return httpx2.Response(200, json={"request_id": "r"})
            return httpx2.Response(404, json={"error_code": "NOT_FOUND"})

        return httpx2.MockTransport(handle)
