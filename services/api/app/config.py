"""Runtime configuration, read from STACKD_* environment variables.

A `.env` file in the working directory is read in development. Nothing secret has a
default: a missing value fails at start-up instead of silently running with a dev value.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Env = Literal["dev", "test", "prod"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="STACKD_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    env: Env = "dev"

    # PostgreSQL, via psycopg 3. Account, plan, groups, alert schedule, backup index only.
    database_url: str

    # S3-compatible object storage. Ciphertext backup blobs only; never statements or receipts.
    s3_endpoint_url: str
    s3_region: str = "us-east-1"
    s3_bucket: str = "stackd-backups"
    s3_access_key: str
    s3_secret_key: SecretStr

    # Security (chunk 0.5)
    ip_hash_key: SecretStr  # HMAC key: client IPs and rate-limit keys are stored as pseudonyms
    trust_proxy_headers: bool = False  # only behind our own proxy: client IP from X-Forwarded-For
    # Shared secret CloudFront adds as X-Origin-Verify on every /api request it forwards; when
    # set, a request without it is refused, so the container's own address is useless directly.
    origin_verify: SecretStr | None = None
    step_up_max_age_seconds: int = (
        300  # a passkey check within 5 minutes for sensitive routes (signed off Oct 27, 2026)
    )

    # Auth (chunk 1.2). Values from docs/spec.md "Authentication", signed off Oct 27, 2026.
    secret_key: SecretStr  # HMAC key for one-time codes and session tokens at rest
    rp_id: str = "localhost"  # WebAuthn relying party id: the app's registrable domain
    rp_name: str = "Qash"
    origins: list[str] = ["http://localhost:5173"]  # WebAuthn expected origins (JSON list)
    cookie_secure: bool = False  # True in prod: the session cookie is sent over HTTPS only
    site_origin: str = (
        "http://localhost:4321"  # the public website (apps/site); CORS for /api/public/
    )
    session_ttl_days: int = 30  # per-device session (the cookie is the refresh token)
    lock_after_seconds: int = 300  # auto-lock after 5 minutes without activity
    # Tester tools (owner decision, October 18, 2026): accounts that may switch their own plan
    # for free and skip the 30-day downgrade wait, to test every plan. A JSON list of emails,
    # kept in the secret store only, never in the repository. Empty: nobody.
    admin_emails: list[str] = []
    deletion_grace_days: int = (
        30  # proposed: the spec leaves the timing to legal; state it in the policy
    )
    # Web Push (VAPID). Without a key pair, push is off and the app says so.
    vapid_private_key: SecretStr | None = None  # EC P-256 private key, PEM
    vapid_public_key: str | None = None  # base64url of the uncompressed public point, for the app
    vapid_subject: str = "mailto:security@localhost"  # VAPID contact; prod: security@qash.solutions
    # Native push (Phase 2, chunk 2.3): APNs for iOS, FCM v1 for Android. Each platform is
    # off without its credentials, exactly like Web Push without VAPID keys.
    apns_key: SecretStr | None = None  # the .p8 token-signing key (PEM contents)
    apns_key_id: str | None = None
    apns_team_id: str | None = None
    apns_topic: str = "com.stackd.app"  # the iOS bundle id (apps/mobile)
    apns_use_sandbox: bool = True  # api.sandbox.push.apple.com until store builds exist
    fcm_service_account: SecretStr | None = None  # the Firebase service-account JSON
    # Native billing (Phase 2, chunk 2.4). The Apple root pin ships with the API
    # (app/services/apple_root_ca_g3.pem); the setting overrides it (tests use their own).
    apple_root_ca: str | None = None  # PEM; None = the bundled Apple Root CA - G3
    # Off (owner decision, October 13, 2026: subscriptions are sold on the web through Stripe
    # only). While off, the Apple and Google webhooks answer 404 and /native/sync 503, so no
    # store-signed payload can grant a plan (October 29, 2026).
    store_billing: bool = False
    play_service_account: SecretStr | None = None  # Play Developer API service-account JSON
    play_package: str = "com.stackd.app"  # the Android application id (apps/mobile)
    # Stripe (hosted Checkout + Customer Portal + webhooks). Billing is off without the key.
    stripe_secret_key: SecretStr | None = None
    stripe_webhook_secret: SecretStr | None = None
    stripe_price_private_monthly: str | None = None
    stripe_price_private_yearly: str | None = None
    stripe_price_connected_monthly: str | None = None
    stripe_price_connected_yearly: str | None = None
    stripe_price_founding: str | None = None  # one-time, 4 years of Connected
    # The payment method configuration (pmc_...) Checkout uses: US cards and US bank accounts
    # (October 24, 2026). Stripe no longer takes payment_method_types on Checkout; without
    # this the Dashboard's default configuration decides. Not a secret.
    stripe_payment_method_config: str | None = None
    # Who may start a purchase (owner decision, October 26, 2026): "off" nobody, "admins" only
    # STACKD_ADMIN_EMAILS (a live test with a real card before launch), "everyone" at launch.
    # Unset means "off" in production and "everyone" elsewhere, so live keys in the secret
    # never open sales by themselves. Plans already bought keep working either way.
    billing_open: Literal["off", "admins", "everyone"] | None = None
    # Read-only bank and card linking (Phase 3, docs/security/linking.md). Off without all three.
    plaid_client_id: str | None = None  # not secret, but kept with the secret
    plaid_secret: SecretStr | None = None
    plaid_env: Literal["sandbox", "production"] = "sandbox"
    plaid_webhook_url: str | None = None  # <app origin>/api/webhooks/plaid, or none
    link_dormant_days: int = 60  # spec: revoke after 60 days without opening the app
    link_token_key: SecretStr | None = (
        None  # Fernet key (urlsafe base64, 32 bytes); nothing else uses it
    )
    otp_ttl_seconds: int = 600  # codes are valid for 10 minutes
    otp_max_attempts: int = 5  # then a lockout
    otp_lockout_seconds: int = 900  # 15 minutes
    otp_resend_seconds: int = 60  # resend cooldown shown as a countdown

    # Transactional email: SMTP keeps the provider choice open (any provider offers a relay).
    email_backend: Literal["console", "smtp", "memory"] = "console"
    email_from: str = "Qash <no-reply@localhost>"
    smtp_host: str = "localhost"
    smtp_port: int = 1025  # Mailpit in docker-compose
    smtp_user: str | None = None
    smtp_password: SecretStr | None = None
    smtp_starttls: bool = False

    @property
    def is_prod(self) -> bool:
        return self.env == "prod"

    @model_validator(mode="after")
    def _prod_is_configured(self) -> Settings:
        if self.is_prod:
            problems = []
            if not self.cookie_secure:
                problems.append("STACKD_COOKIE_SECURE must be true")
            if self.email_backend != "smtp":
                problems.append("STACKD_EMAIL_BACKEND must be smtp")
            if self.rp_id == "localhost":
                problems.append("STACKD_RP_ID must be the app's domain")
            if any(o.startswith("http://") for o in self.origins):
                problems.append("STACKD_ORIGINS must be https")
            if not self.site_origin.startswith("https://"):
                problems.append("STACKD_SITE_ORIGIN must be https")
            if self.origin_verify is None or not self.origin_verify.get_secret_value():
                problems.append("STACKD_ORIGIN_VERIFY must be set")
            if not self.trust_proxy_headers:
                problems.append("STACKD_TRUST_PROXY_HEADERS must be true (behind CloudFront)")
            if problems:
                raise ValueError("production settings: " + "; ".join(problems))
        return self

    @field_validator("billing_open", mode="before")
    @classmethod
    def _blank_billing_open_is_unset(cls, value: object) -> object:
        # docker compose passes an unset variable as "": that means unset, so "off" in prod.
        return None if isinstance(value, str) and not value.strip() else value

    @field_validator("database_url")
    @classmethod
    def _postgres_via_psycopg(cls, value: str) -> str:
        if not value.startswith("postgresql+psycopg://"):
            raise ValueError("STACKD_DATABASE_URL must start with postgresql+psycopg://")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # fields come from the environment
