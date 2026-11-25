"""Every email goes out as plain text and in the Qash layout (owner, November 24, 2026)."""

from email import message_from_bytes
from email import policy as email_policy

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
    assert 'src="cid:qash-logo"' in page and 'alt="Qash"' in page
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


def test_the_logo_opens_the_app_words_link_and_fine_print_sits_under_a_line() -> None:
    m = Message(
        to="a@example.com",
        subject="S",
        text="t",
        html_text="[Cancel <any> time](https://app.example/me/plan) on the Plan screen.",
        actions=(("Your plan", "https://app.example/me/plan"),),
        fine_print="This was done on Chrome on Mac.",
    )
    page = m.html
    app = email.app_link()
    assert f'<a href="{app}" style="display:inline-block"><img src="cid:qash-logo"' in page
    assert ">Cancel &lt;any&gt; time</a> on the Plan screen." in page
    assert "[Cancel" not in page
    fine = page.index("This was done on Chrome on Mac.")
    assert fine > page.index(">Your plan</a>")
    assert (
        "border-top:1px solid" in page[fine - 200 : fine]
        and "font-size:13px" in page[fine - 200 : fine]
    )
    assert email.plain("[Cancel any time](https://x.example/) now") == "Cancel any time now"


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
    parsed = message_from_bytes(sent[0], policy=email_policy.default)
    assert parsed.get_content_type() == "multipart/alternative"
    plain, rich = parsed.get_payload()
    assert plain.get_content_type() == "text/plain"
    # The HTML travels with the logo inside it, so no mail app fetches an image.
    assert rich.get_content_type() == "multipart/related"
    page, logo = rich.get_payload()
    assert page.get_content_type() == "text/html" and 'src="cid:qash-logo"' in page.get_content()
    assert logo.get_content_type() == "image/png" and logo["Content-ID"] == "<qash-logo>"
    assert logo.get_payload(decode=True) == email.logo_png()


def test_if_it_wasnt_you_links_straight_to_sign_in_and_security() -> None:
    """Someone who didn't do it may not know where Qash is (owner, November 25, 2026)."""
    from app.services.email import plan_kept_message, security_link
    from app.services.security_alerts import SecurityEvent, send_alert

    m = plan_kept_message(
        "a@example.com",
        "https://app.example/me/plan",
        plan="Private · monthly",
        price="$3.00 a month",
        next_charge="$3.00 on Dec 2, 2026",
        every="month",
        invoice_link=None,
        done_on="Chrome on Mac, Nov 25, 2026 at 3:28 PM CST",
    )
    link = security_link()
    assert f'<a href="{link}"' in m.html and ">open Sign-in &amp; security in Qash</a>" in m.html
    assert f"open Sign-in & security in Qash ({link})" in m.text and "[" not in m.text
    alert = send_alert(
        "a@example.com",
        SecurityEvent.NEW_SIGN_IN,
        device_label="Chrome on Mac",
        at=__import__("datetime").datetime(2026, 11, 25),
    )
    assert f'<a href="{link}"' in alert.html
    assert f"({link})" in alert.text and "[open" not in alert.text
