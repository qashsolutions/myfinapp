from pathlib import Path

import httpx2
import pytest

from app.security.outbound import (
    ALLOWLIST_PATH,
    OutboundHostNotAllowed,
    assert_allowed,
    host_allowed,
    outbound_client,
)

REPO_ALLOWLIST = Path(__file__).resolve().parents[4] / "tools" / "network_allowlist.txt"


def test_packaged_allowlist_matches_the_ci_guard_copy() -> None:
    assert REPO_ALLOWLIST.exists(), "run from the repo checkout"
    assert ALLOWLIST_PATH.read_text() == REPO_ALLOWLIST.read_text(), (
        "cp tools/network_allowlist.txt services/api/app/security/network_allowlist.txt"
    )


@pytest.mark.parametrize(
    ("host", "allowed"),
    [
        ("api.stripe.com", True),
        ("checkout.stripe.com", True),
        ("stripe.com", False),
        ("web.push.apple.com", True),
        ("push.apple.com", True),
        ("apple.com", False),
        ("localhost", True),
        ("127.0.0.1", True),
        ("storage", False),
        ("api.openai.com", False),
        ("API.STRIPE.COM", True),
    ],
)
def test_host_rules(host: str, allowed: bool) -> None:
    assert host_allowed(host) is allowed


def test_assert_allowed_reads_the_host_from_the_url() -> None:
    assert_allowed("https://api.stripe.com/v1/checkout/sessions")
    with pytest.raises(OutboundHostNotAllowed):
        assert_allowed("https://api.openai.com/v1/chat")  # net-allow: runtime guard test


def test_client_refuses_before_connecting() -> None:
    seen: list[str] = []

    def transport_handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.url.host)
        return httpx2.Response(200, json={"ok": True})

    with outbound_client(transport=httpx2.MockTransport(transport_handler)) as c:
        assert c.get("https://api.stripe.com/v1/balance").json() == {"ok": True}
        with pytest.raises(OutboundHostNotAllowed):
            c.get("https://api.openai.com/v1/models")  # net-allow: runtime guard test
    assert seen == ["api.stripe.com"]  # the blocked request never reached the transport


def test_client_keeps_caller_hooks() -> None:
    calls: list[str] = []
    with outbound_client(
        transport=httpx2.MockTransport(lambda r: httpx2.Response(204)),
        event_hooks={"request": [lambda r: calls.append(str(r.url))]},
    ) as c:
        c.get("https://api.stripe.com/v1/x")
    assert calls == ["https://api.stripe.com/v1/x"]
