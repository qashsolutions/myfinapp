"""ORM models. Import every model here so Alembic and Base.metadata see all tables."""

from app.models.audit_log import AuditLog
from app.models.backup import Backup, BackupKey
from app.models.base import Base, StackdRow
from app.models.billing import (
    BillingEvent,
    CheckoutPage,
    Entitlement,
    PurchaseBlock,
    PurchaseConsent,
    Subscription,
)
from app.models.device_link import DeviceLink
from app.models.group import Group
from app.models.group_member import GroupMember
from app.models.household import Household, HouseholdBlob, HouseholdInvite, HouseholdMember
from app.models.linking import BankConnection, LinkSession
from app.models.notification import (
    AlertSchedule,
    NotificationLog,
    NotificationPref,
    NotificationSettings,
    PushSubscription,
)
from app.models.otp_code import OtpCode
from app.models.plan_event import PlanEvent
from app.models.rate_limit import RateLimitBucket
from app.models.recovery import AccountRecovery
from app.models.session import Session
from app.models.trial_claim import TrialClaim
from app.models.user import User
from app.models.webauthn_challenge import WebauthnChallenge
from app.models.webauthn_credential import WebauthnCredential

__all__ = [
    "AccountRecovery",
    "AlertSchedule",
    "AuditLog",
    "Backup",
    "BackupKey",
    "BankConnection",
    "Base",
    "BillingEvent",
    "CheckoutPage",
    "DeviceLink",
    "Entitlement",
    "Group",
    "GroupMember",
    "Household",
    "HouseholdBlob",
    "HouseholdInvite",
    "HouseholdMember",
    "LinkSession",
    "NotificationLog",
    "NotificationPref",
    "NotificationSettings",
    "OtpCode",
    "PurchaseConsent",
    "PushSubscription",
    "RateLimitBucket",
    "Session",
    "StackdRow",
    "Subscription",
    "TrialClaim",
    "PlanEvent",
    "PurchaseBlock",
    "User",
    "WebauthnChallenge",
    "WebauthnCredential",
]
