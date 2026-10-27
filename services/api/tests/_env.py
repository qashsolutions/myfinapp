"""Test environment. Imported first by conftest.py, before any `app` module reads settings.

Tests run against a real Postgres and a real S3-compatible store (local Homebrew services,
the docker-compose stack, or CI's service containers). Explicit environment variables win
over any `.env` file, so a developer's dev database is never touched: the database name
must end in `_test` or the run aborts.
"""

from __future__ import annotations

import os

from sqlalchemy.engine import make_url

TEST_DATABASE_URL = os.environ.get(
    "STACKD_TEST_DATABASE_URL", "postgresql+psycopg://stackd:stackd@localhost:5432/stackd_test"
)
TEST_BUCKET = "stackd-test"

_db_name = make_url(TEST_DATABASE_URL).database or ""
if not _db_name.endswith("_test"):
    raise SystemExit(
        f"refusing to run tests against database {_db_name!r}: "
        "STACKD_TEST_DATABASE_URL must name a database ending in _test"
    )

os.environ["STACKD_ENV"] = "test"
os.environ["STACKD_DATABASE_URL"] = TEST_DATABASE_URL
os.environ["STACKD_S3_BUCKET"] = TEST_BUCKET
os.environ.setdefault("STACKD_S3_ENDPOINT_URL", "http://localhost:9000")
os.environ.setdefault("STACKD_S3_REGION", "us-east-1")
os.environ.setdefault("STACKD_S3_ACCESS_KEY", "stackd")
os.environ.setdefault("STACKD_S3_SECRET_KEY", "stackd-dev-storage")
os.environ.setdefault("STACKD_IP_HASH_KEY", "test-ip-hash-key")
os.environ["STACKD_SECRET_KEY"] = "test-secret-key"
os.environ["STACKD_RP_ID"] = "localhost"
os.environ["STACKD_ORIGINS"] = '["http://localhost:5173"]'
os.environ["STACKD_EMAIL_BACKEND"] = "memory"
os.environ["STACKD_COOKIE_SECURE"] = "false"
os.environ["STACKD_TRUST_PROXY_HEADERS"] = "true"  # tests/auth_flow.new_client sets X-Forwarded-For

# A VAPID key pair for the push tests (generated per run; never a real key).
import base64  # noqa: E402

from cryptography.hazmat.primitives import serialization  # noqa: E402
from py_vapid import Vapid  # noqa: E402

_vapid = Vapid()
_vapid.generate_keys()
os.environ["STACKD_VAPID_PRIVATE_KEY"] = _vapid.private_pem().decode()
os.environ["STACKD_VAPID_PUBLIC_KEY"] = (
    base64.urlsafe_b64encode(
        _vapid.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
    )
    .decode()
    .rstrip("=")
)
os.environ["STACKD_VAPID_SUBJECT"] = "mailto:security@example.com"
os.environ["STACKD_STRIPE_SECRET_KEY"] = "sk_test_stackd"
os.environ["STACKD_STRIPE_WEBHOOK_SECRET"] = "whsec_test_stackd"
os.environ["STACKD_STRIPE_PRICE_PRIVATE_MONTHLY"] = "price_private_m"
os.environ["STACKD_STRIPE_PRICE_PRIVATE_YEARLY"] = "price_private_y"
os.environ["STACKD_STRIPE_PRICE_CONNECTED_MONTHLY"] = "price_connected_m"
os.environ["STACKD_STRIPE_PRICE_CONNECTED_YEARLY"] = "price_connected_y"
os.environ["STACKD_STRIPE_PRICE_FOUNDING"] = "price_founding"
os.environ["STACKD_STRIPE_PAYMENT_METHOD_CONFIG"] = "pmc_cards_only"
# Linking (Phase 3): a fake Plaid answers through plaid.transport_override; the key is per run.
from cryptography.fernet import Fernet  # noqa: E402

os.environ["STACKD_PLAID_CLIENT_ID"] = "test-client"
os.environ["STACKD_PLAID_SECRET"] = "test-plaid-secret"
os.environ["STACKD_PLAID_ENV"] = "sandbox"
os.environ["STACKD_LINK_TOKEN_KEY"] = Fernet.generate_key().decode()

# APNs and FCM credentials for the native-push tests (generated per run; never real keys).
import json  # noqa: E402

from cryptography.hazmat.primitives.asymmetric import ec, rsa  # noqa: E402

_pem = {
    "encoding": serialization.Encoding.PEM,
    "format": serialization.PrivateFormat.PKCS8,
    "encryption_algorithm": serialization.NoEncryption(),
}
os.environ["STACKD_APNS_KEY"] = (
    ec.generate_private_key(ec.SECP256R1()).private_bytes(**_pem).decode()
)
os.environ["STACKD_APNS_KEY_ID"] = "TESTKEY123"
os.environ["STACKD_APNS_TEAM_ID"] = "TEAMTEST12"
os.environ["STACKD_FCM_SERVICE_ACCOUNT"] = json.dumps(
    {
        "type": "service_account",
        "project_id": "stackd-test",
        "client_email": "push@stackd-test.iam.gserviceaccount.com",
        "private_key": rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .private_bytes(**_pem)
        .decode(),
        "token_uri": "https://oauth2.googleapis.com/token",
    }
)

# Native billing (chunk 2.4): the fake Apple chain pins the test root; Play gets a second
# per-run service account, so the FCM one's cache never collides.
from tests.apple_fake import ROOT_PEM  # noqa: E402

os.environ["STACKD_APPLE_ROOT_CA"] = ROOT_PEM
os.environ["STACKD_PLAY_SERVICE_ACCOUNT"] = json.dumps(
    {
        "type": "service_account",
        "project_id": "stackd-test",
        "client_email": "play@stackd-test.iam.gserviceaccount.com",
        "private_key": rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .private_bytes(**_pem)
        .decode(),
        "token_uri": "https://oauth2.googleapis.com/token",
    }
)
