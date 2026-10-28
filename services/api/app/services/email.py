"""Transactional email.

The provider is still an open choice (docs/spec.md "Architecture & stack": transactional
provider). Every candidate offers an SMTP relay, so SMTP keeps the decision open without
adding a host to the outbound allowlist. `console` prints in development; `memory` records
for tests.
"""

from __future__ import annotations

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from functools import lru_cache
from typing import Protocol

from app.config import get_settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Message:
    to: str
    subject: str
    text: str


class EmailSender(Protocol):
    def send(self, message: Message) -> None: ...


class ConsoleEmailSender:
    def send(self, message: Message) -> None:
        log.info("email to %s | %s\n%s", message.to, message.subject, message.text)
        print(f"--- email to {message.to}\nSubject: {message.subject}\n\n{message.text}\n---")


class MemoryEmailSender:
    def __init__(self) -> None:
        self.outbox: list[Message] = []

    def send(self, message: Message) -> None:
        self.outbox.append(message)


class SmtpEmailSender:
    def send(self, message: Message) -> None:
        s = get_settings()
        msg = EmailMessage()
        msg["From"] = s.email_from
        msg["To"] = message.to
        msg["Subject"] = message.subject
        msg.set_content(message.text)
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=10) as smtp:
            if s.smtp_starttls:
                smtp.starttls()
            if s.smtp_user and s.smtp_password:
                smtp.login(s.smtp_user, s.smtp_password.get_secret_value())
            smtp.send_message(msg)


@lru_cache
def get_sender() -> EmailSender:
    backend = get_settings().email_backend
    if backend == "smtp":
        return SmtpEmailSender()
    if backend == "memory":
        return MemoryEmailSender()
    return ConsoleEmailSender()


def deletion_code_message(to: str, code: str, ttl_minutes: int, link: str) -> Message:
    """The public deletion page's code (docs/spec.md 1W "W.3"); the link carries the same code."""
    return Message(
        to=to,
        subject=f"Confirm deleting your Qash account: {code}",
        text=(
            f"Someone asked to delete the Qash account for this address. To confirm, enter "
            f"this code on the deletion page: {code}\n\nOr open: {link}\n\n"
            f"It expires in {ttl_minutes} minutes and works once. If this wasn't you, ignore "
            "this email; nothing happens without the code.\n"
        ),
    )


def otp_message(to: str, code: str, ttl_minutes: int) -> Message:
    return Message(
        to=to,
        subject=f"Your Qash code: {code}",
        text=(
            f"Enter this code in Qash: {code}\n\n"
            f"It expires in {ttl_minutes} minutes and works once. "
            "If you didn't ask for it, you can ignore this email; nobody can sign in "
            "without the code and your passkey.\n"
        ),
    )


def weekly_recap_message(to: str, link: str) -> Message:
    """The weekly recap by email (fast-follow 6). No numbers: those stay on the device."""
    return Message(
        to=to,
        subject="Your weekly recap is ready",
        text=(
            "Your week in Qash is ready to look at: what came in, what went out, what you "
            f"kept, and where your jars stand.\n\nOpen your recap: {link}\n\n"
            "This email never carries your numbers; they stay on your device. To change the "
            "day, the time, or how this arrives, open Me \u2192 Notifications in the app.\n"
        ),
    )


def plan_ending_message(to: str, end: str, link: str, trial: bool) -> Message:
    """The day before a free trial or a cancelled plan ends (owner decision, October 14, 2026;
    friendly, not a warning: October 20, 2026)."""
    what = "Your free trial" if trial else "Your Qash plan"
    return Message(
        to=to,
        subject=f"{what} wraps up on {end}",
        text=(
            f"Hi! {what} wraps up on {end}.\n\n"
            f"Want to keep going? Pick a plan here:\n{link}\n\n"
            "No pressure. If you don't, you'll have 7 more days to choose a plan or download "
            "your data, and what's on your device stays there until you decide.\n"
        ),
    )


def plan_ended_message(to: str, delete_on: str, link: str) -> Message:
    """The trial or paid period has ended with no subscription: the first of the daily notes."""
    return Message(
        to=to,
        subject="Your Qash trial has wrapped up",
        text=(
            "Thanks for trying Qash. Your trial has wrapped up, and nothing has been deleted.\n\n"
            f"Keep going: {link}\n\n"
            "Or take your data with you: open the app, then Me → Download all my data.\n\n"
            f"Your account stays open until {delete_on}. After that we close it, and what's on "
            "your phone stays there until you choose to download it or erase it.\n"
        ),
    )


def plan_lapsed_reminder_message(to: str, delete_on: str, days_left: int, link: str) -> Message:
    """One a day for the rest of the 7 days after a plan ended (owner, October 20, 2026)."""
    days = "1 day" if days_left == 1 else f"{days_left} days"
    return Message(
        to=to,
        subject=f"A friendly reminder: {days} left to keep your Qash account",
        text=(
            f"Just a friendly note: your Qash account stays open for {days} more, until "
            f"{delete_on}.\n\nKeep going: {link}\n\n"
            "Or download your data in the app (Me → Download all my data). Either way, what's "
            "on your device stays there until you decide.\n"
        ),
    )


def account_deleted_after_plan_message(to: str, *, welcome_back: bool = True) -> Message:
    """`welcome_back` False: the inbox may not buy again (a lost dispute or a fraud warning), so
    the note doesn't invite signing up again."""
    again = (
        "You're welcome back any time. Sign up again on the same phone and Qash offers to "
        "bring that data into your new account.\n"
        if welcome_back
        else "Questions? Write to support@qash.solutions.\n"
    )
    return Message(
        to=to,
        subject="Your Qash account has closed",
        text=(
            "Your Qash plan ended 7 days ago, so we've closed your account and removed what we "
            "kept on our servers, as we said we would.\n\n"
            "What's on your device is still there. Open Qash to download it or erase it, "
            "whenever you like.\n\n" + again
        ),
    )


def plan_ended_payment_returned_message(to: str, delete_on: str) -> Message:
    """A plan ended because its payment was refunded as possible fraud (October 25, 2026): the
    one note while the account stays open. No link to buy again, since this inbox may not."""
    return Message(
        to=to,
        subject="Your Qash plan has ended",
        text=(
            "We refunded the payment for your Qash plan after your bank flagged it, so the plan "
            "has ended. Nothing has been deleted.\n\n"
            "Take your data with you: open the app, then Me → Download all my data.\n\n"
            f"Your account stays open until {delete_on}. After that we close it, and what's on "
            "your phone stays there until you choose to download it or erase it.\n\n"
            "Questions? Write to support@qash.solutions.\n"
        ),
    )


def founding_sold_out_message(to: str) -> Message:
    """A Founding payment that arrived after the last place went (October 24, 2026)."""
    return Message(
        to=to,
        subject="The Founding offer filled up, so we've refunded you",
        text=(
            "Thank you for wanting to be a Founding member. The last place went while your "
            "payment was going through, so we've refunded it in full, with no fee taken. It "
            "should reach your card within 5 to 10 business days.\n\n"
            "Your account is unchanged, and the Private and Connected plans are open any time "
            "from Me, then Plan.\n"
        ),
    )


def plan_link() -> str:
    """The Plan screen in the app, for emails about a plan."""
    return f"{get_settings().origins[0].rstrip('/')}/me/plan"


def bank_payment_failed_message(to: str, link: str) -> Message:
    """A US bank payment that didn't clear (October 24, 2026)."""
    return Message(
        to=to,
        subject="Your bank payment didn't go through",
        text=(
            "Your bank payment for Qash didn't go through, so your plan hasn't started and "
            "nothing was taken. This can happen when an account is closed or doesn't have "
            "enough in it.\n\n"
            f"You can try again with a card or another bank account here:\n{link}\n"
        ),
    )


def plan_paused_message(to: str, link: str) -> Message:
    """A payment was disputed with the bank (owner decision, October 24, 2026)."""
    return Message(
        to=to,
        subject="Your Qash plan is paused while a payment is disputed",
        text=(
            "Your bank told us one of your Qash payments is being disputed, so your plan is "
            "paused for now. Nothing is deleted: everything stays on your device, and you can "
            "still open the app and download your data.\n\n"
            "If the dispute is withdrawn or closed in our favour, your plan comes back by "
            "itself. If you didn't mean to dispute it, your bank can withdraw it. Questions? "
            "Reply to this email.\n\n"
            f"Your plan: {link}\n"
        ),
    )


def plan_resumed_message(to: str, link: str) -> Message:
    return Message(
        to=to,
        subject="Your Qash plan is back",
        text=(
            "The payment dispute is closed, and your Qash plan is back, just as you left it.\n\n"
            f"Your plan: {link}\n"
        ),
    )


def plan_ended_dispute_lost_message(to: str, link: str) -> Message:
    """A dispute decided for the person (owner decision, October 25, 2026): the plan has ended,
    the account stays open, and nothing is deleted because of it. `link` is unused: there is
    no plan to buy (the inbox may not buy again); the signature matches the other notes."""
    del link
    return Message(
        to=to,
        subject="Your Qash plan has ended",
        text=(
            "Your bank decided the payment dispute in your favour and returned the money, so "
            "your Qash plan has ended and won't be charged again.\n\n"
            "Nothing has been deleted, and your account stays open. You can download your data "
            "any time (Me → Download all my data), or delete your account whenever you like.\n\n"
            "Questions? Write to support@qash.solutions.\n"
        ),
    )


def fraud_refund_message(to: str, link: str) -> Message:
    """The card's bank flagged a payment as possibly not made by the cardholder, so it was
    refunded in full and the plan ended (owner decision, October 24, 2026)."""
    return Message(
        to=to,
        subject="We refunded a Qash payment and ended your plan",
        text=(
            "The bank that issued the card used for your Qash plan told us the payment may not "
            "have been made by the cardholder. To be safe, we refunded it in full and ended the "
            "plan. Nothing is deleted: everything stays on your device, and you can still open "
            "the app and download your data.\n\n"
            "If the payment was yours, reply to this email and we'll sort it out with you.\n\n"
            f"Your plan: {link}\n"
        ),
    )


def fraud_admin_message(to: str, warning_id: str) -> Message:
    """To the admins: a payment refunded on an early fraud warning (no amounts, no names)."""
    return Message(
        to=to,
        subject="A Qash payment was refunded on a fraud warning",
        text=(
            f"The card's bank sent an early fraud warning ({warning_id}). The payment was "
            "refunded in full, the plan ended, and the card and inbox can't buy again. Nothing "
            "to answer in the Stripe Dashboard.\n"
        ),
    )


def dispute_admin_message(to: str, dispute_id: str, *, matched: bool = True) -> Message:
    """To the admins: a dispute to answer in the Stripe Dashboard (no amounts, no names).
    `matched`: whether the app found the plan it paid for; Stripe wants evidence either way."""
    what = (
        "The plan it paid for is paused."
        if matched
        else "No current Qash plan matches it (it may already be refunded, refused, or the "
        "account deleted), so nothing changed in the app."
    )
    return Message(
        to=to,
        subject="A Qash payment was disputed",
        text=(
            f"A payment was disputed ({dispute_id}). {what} Respond with evidence in the "
            "Stripe Dashboard before its deadline.\n"
        ),
    )
