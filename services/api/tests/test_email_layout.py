"""Every email goes out as plain text and in the Qash layout (owner, November 24, 2026)."""

from email import message_from_bytes

import pytest

from app.services import email
from app.services.email import Message, SmtpEmailSender


def test_the_layout_has_the_logo_the_words_and_escapes_what_it_is_given() -> None:
    m = Message(
        to="a@example.com",
        subject="Hello <there>",
        text="First line & more.\n\nOpen https://app.example/me/plan now.",
    )
    page = m.html
    assert "/icons/logo.png" in page and 'alt="Qash"' in page
    assert "Hello &lt;there&gt;" in page and "First line &amp; more." in page
    assert '<a href="https://app.example/me/plan"' in page
    assert "support@qash.solutions" in page


def test_rows_and_buttons_draw_and_html_text_replaces_the_prose() -> None:
    m = Message(
        to="a@example.com",
        subject="S",
        text="Plain only: Plan: Private",
        rows=(("Plan", "Private · monthly"),),
        actions=(("Keep my plan", "https://app.example/me/plan?a=1&b=2"),),
        html_text="Shown in HTML.",
    )
    page = m.html
    assert "Private · monthly" in page and "Shown in HTML." in page
    assert "Plain only" not in page
    assert 'href="https://app.example/me/plan?a=1&amp;b=2"' in page and ">Keep my plan</a>" in page


def test_smtp_sends_text_and_html_together(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[bytes] = []

    class FakeSmtp:
        def __init__(self, *a, **k) -> None: ...
        def __enter__(self):
            return self

        def __exit__(self, *a) -> None: ...
        def starttls(self) -> None: ...
        def login(self, *a) -> None: ...
        def send_message(self, msg) -> None:
            sent.append(msg.as_bytes())

    monkeypatch.setattr(email.smtplib, "SMTP", FakeSmtp)
    SmtpEmailSender().send(Message(to="a@example.com", subject="S", text="Words."))
    parsed = message_from_bytes(sent[0])
    assert parsed.get_content_type() == "multipart/alternative"
    kinds = [part.get_content_type() for part in parsed.get_payload()]
    assert kinds == ["text/plain", "text/html"]
