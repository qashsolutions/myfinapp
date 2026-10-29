"""Invariant 71 (October 29, 2026): an ended challenge's final board never changes.

Before, `PUT /api/groups/{id}/progress` never read the end date: a device opening an October
dining diet on November 3 posted November's near-zero spending as a near-100% figure, and could
stamp `reached_at` after the end. Now a post counts only while the challenge runs somewhere.

Every type × every moment, worked out by hand. The moments, in UTC, for a challenge whose first
day is S and last day E (local dates):

    before_start     S−2 at 12:00   not begun anywhere (UTC+14 starts S at S−1 10:00)
    during           S at 12:00
    last_day         E at 12:00
    after_end        E+1 at 06:00   over in UTC, still E at UTC−12: a late last-day post counts
    over_everywhere  E+1 at 12:00   over at UTC−12 too

Lookup and join are open until the challenge is over everywhere (invariant 56); progress from
its first day anywhere until then; leaving is always open (leaving is never harder than joining).
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from app.routers import groups as groups_router
from tests.auth_flow import outbox
from tests.test_group_ended import person


@pytest.fixture(autouse=True)
def _infra(migrated, bucket):
    outbox().clear()


CREATED = datetime(2026, 10, 15, 12, tzinfo=UTC)
# Each type with the body that creates it and its first and last day.
TYPES = {
    "monthly_savings": ({"month": "2026-11"}, date(2026, 11, 1), date(2026, 11, 30)),
    "dining_diet": ({"month": "2026-11"}, date(2026, 11, 1), date(2026, 11, 30)),
    "no_eat_out_week": ({"start_date": "2026-10-20"}, date(2026, 10, 20), date(2026, 10, 26)),
    "no_spend_weekend": ({"start_date": "2026-10-24"}, date(2026, 10, 24), date(2026, 10, 25)),
    "fifty_two_week": ({"start_date": "2026-10-19"}, date(2026, 10, 19), date(2027, 10, 17)),
}


def _at(day: date, hour: int) -> datetime:
    return datetime.combine(day, datetime.min.time(), tzinfo=UTC) + timedelta(hours=hour)


MOMENTS = {
    "before_start": lambda s, e: _at(s - timedelta(days=2), 12),
    "during": lambda s, e: _at(s, 12),
    "last_day": lambda s, e: _at(e, 12),
    "after_end": lambda s, e: _at(e + timedelta(days=1), 6),
    "over_everywhere": lambda s, e: _at(e + timedelta(days=1), 12),
}
# moment → (lookup, join, progress, leave) status codes, the same for every type.
EXPECTED = {
    "before_start": (200, 200, 409, 204),
    "during": (200, 200, 200, 204),
    "last_day": (200, 200, 200, 204),
    "after_end": (200, 200, 200, 204),
    "over_everywhere": (409, 409, 409, 204),
}
PROGRESS_DETAIL = {"before_start": "not_started", "over_everywhere": "ended"}

CASES = [(t, m) for t in TYPES for m in MOMENTS]


@pytest.mark.parametrize(("template", "moment"), CASES, ids=[f"{t}-{m}" for t, m in CASES])
def test_every_type_at_every_moment(
    monkeypatch: pytest.MonkeyPatch, template: str, moment: str
) -> None:
    body, first, last = TYPES[template]
    monkeypatch.setattr(groups_router, "_now", lambda: CREATED)
    owner, member, late = person("Owner"), person("Member"), person("Late")
    r = owner.post("/api/groups", json={"name": "", "template_key": template, **body})
    assert r.status_code == 201, r.text
    gid, code = r.json()["id"], r.json()["invite_code"]
    assert (r.json()["start_date"], r.json()["end_date"]) == (first.isoformat(), last.isoformat())
    assert member.post("/api/groups/join", json={"code": code}).status_code == 200
    # A figure already on the board, posted while it ran, so "unchanged" means something.
    monkeypatch.setattr(groups_router, "_now", lambda: _at(first, 12))
    assert owner.put(f"/api/groups/{gid}/progress", json={"progress_bps": 4000}).status_code == 200

    now = MOMENTS[moment](first, last)
    monkeypatch.setattr(groups_router, "_now", lambda: now)
    lookup, join, progress, leave = EXPECTED[moment]

    assert late.post("/api/groups/lookup", json={"code": code}).status_code == lookup
    assert late.post("/api/groups/join", json={"code": code}).status_code == join

    r = owner.put(f"/api/groups/{gid}/progress", json={"progress_bps": 10000})
    assert r.status_code == progress, r.text
    board = {m["is_me"]: m for m in owner.get(f"/api/groups/{gid}").json()["members"]}
    if progress == 200:
        assert board[True]["progress_bps"] == 10000
        assert board[True]["reached_at"] is not None
    else:
        assert r.json()["detail"] == PROGRESS_DETAIL[moment]
        # Nothing on the board moved: the figure from before, and no reached time.
        assert board[True]["progress_bps"] == 4000
        assert board[True]["reached_at"] is None

    assert member.post(f"/api/groups/{gid}/leave").status_code == leave


def test_reached_at_is_never_after_the_challenge_is_over_everywhere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(groups_router, "_now", lambda: CREATED)
    owner = person("Owner")
    r = owner.post(
        "/api/groups",
        json={"name": "", "template_key": "dining_diet", "month": "2026-10"},
    )
    gid = r.json()["id"]
    # The owner's case: November 3, an October dining diet, a near-100% figure.
    monkeypatch.setattr(groups_router, "_now", lambda: datetime(2026, 11, 3, 9, tzinfo=UTC))
    r = owner.put(f"/api/groups/{gid}/progress", json={"progress_bps": 9900})
    assert r.status_code == 409 and r.json()["detail"] == "ended"
    me = owner.get(f"/api/groups/{gid}").json()["members"][0]
    assert me["has_events"] is False and me["reached_at"] is None and me["progress_bps"] == 0
