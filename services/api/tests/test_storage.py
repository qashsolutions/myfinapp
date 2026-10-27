import pytest

from app.config import get_settings
from app.storage import bucket_exists, ensure_bucket


def test_ensure_bucket_is_idempotent(bucket: str) -> None:
    assert bucket_exists()
    assert ensure_bucket() is False  # already there, nothing created


def test_ensure_bucket_refuses_in_prod(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "env", "prod")
    with pytest.raises(RuntimeError):
        ensure_bucket()
