"""What a webhook answers when it can't apply an event (invariant 60, October 29, 2026).

400 only when the sender's own request is wrong (a bad signature, a payload we can't read, a
purchase the store doesn't know): sending it again can't help. Anything that failed on our side
(Stripe or the Play API busy or down, billing not configured, a database error, a bug) answers
5xx, so the sender delivers it again; nothing was recorded as applied, so the retry runs it in
full. Every failure is logged with the event's id, type and the error code; only our own
failures (5xx) are reported to the admins through `ops_alerts` (at most one email per kind and
place an hour; owner decision, October 29, 2026: a refused request is logged, not emailed).
Never the event's contents, an email address or an amount.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException, status

from app.services.ops_alerts import report

log = logging.getLogger("stackd.webhooks")

# The sender's own fault: a retry carries the same request, so it would fail the same way.
REFUSED = frozenset(
    {
        "bad_signature",
        "bad_payload",
        "bad_token",
        "wrong_account",
        "wrong_bundle",
        "unknown_purchase",
        # Plaid's verification (webhook_verify): a token we can't check is refused
        "key_unavailable",
        "stale",
        "body_mismatch",
        "bad_body",
    }
)
# Our dependency's outage, answered as a bad gateway (Pub/Sub and Stripe both retry on it).
UPSTREAM = frozenset({"stripe_error", "stripe_unreachable", "play_api"})


def failed(
    source: str, exc: BaseException, *, event_id: str = "", event_type: str = ""
) -> HTTPException:
    """Log and report one webhook failure, and the HTTP answer that goes back to the sender."""
    code = str(getattr(exc, "code", "") or type(exc).__name__)
    detail = getattr(exc, "detail", None)
    detail = detail if isinstance(detail, str) else None
    log.warning(
        "%s webhook failed: event=%s type=%s code=%s detail=%s",
        source,
        event_id or "-",
        event_type or "-",
        code,
        detail or "-",
    )
    if code in REFUSED:
        # Logged only (owner decision, October 29, 2026): a forged or malformed request is the
        # sender's, not ours to fix, and anyone on the internet can send one.
        return HTTPException(status.HTTP_400_BAD_REQUEST, detail=code)
    where = f"POST /api/webhooks/{source} {event_type or '-'}: {code}"
    if detail:
        where += f" ({detail})"
    report(f"{source}_webhook_failed", where, exc)
    if code in UPSTREAM:
        return HTTPException(status.HTTP_502_BAD_GATEWAY, detail=code)
    if hasattr(exc, "code"):  # one of ours, such as billing_unavailable
        return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail=code)
    return HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail="webhook_failed")
