# stackd-api

The thin server. It stores accounts and passkeys, plans, group **% progress**, a minimal alert schedule and ciphertext backups it cannot read. Statements, receipt photos and transactions never arrive here: they live in IndexedDB on the device and all money math runs there in `@stackd/rules` (ADR 0001).

Chunk 0.4 (API skeleton): FastAPI app, settings, Postgres via SQLAlchemy + psycopg 3, Alembic with the first migration (`users`), an S3-compatible storage client, health endpoints, a `stackd-api` CLI, Dockerfile, and the root `docker-compose.yml`.

## Layout

| Path | Role |
|---|---|
| `app/main.py` | `create_app()`; `uvicorn app.main:app` serves it. Docs and `/openapi.json` are off in prod. |
| `app/config.py` | `Settings`, read from `STACKD_*` env vars (plus `.env` in dev). Secrets have no defaults. |
| `app/db.py` | Engine, per-request `get_db` dependency, Alembic config and `migration_status`. |
| `app/storage.py` | boto3 client for the backup bucket: `bucket_exists`, `ensure_bucket` (dev/test only). |
| `app/models/` | ORM. `StackdRow` mixin gives every table `id` (UUID), `created_at`, `updated_at`. |
| `app/routers/health.py` | `GET /health` (liveness) and `GET /health/ready` (db, migrations at head, bucket). |
| `app/routers/auth.py`, `app/routers/security.py` | Chunk 1.2: one-time codes and the session cookie; passkey registration and assertion, passkeys and devices lists with step-up on removal. |
| `app/routers/public_account.py`, `app/security/cors.py` | Chunk 1W: account deletion from the website by an emailed code, the one cross-origin surface (the site origin only, `/api/public/` only). |
| `app/routers/backup.py`, `app/routers/household.py`, `app/services/backup_store.py`, `app/jobs/backup_purge.py` | Chunk 1.16: wrapped backup keys and ciphertext blobs in object storage (newest three kept; `stackd-api purge-backups`), the household of two with single-use invite codes and ciphertext blobs per author; the PRF salt on passkey assertion options. |
| `app/rules_server/plans.yaml`, `app/rules_server/entitlements.py`, `app/routers/billing.py`, `app/webhooks/stripe.py`, `app/services/stripe_billing.py` | Chunk 1.14: plans and limits (the one table), the effective plan from `subscriptions`, Stripe hosted Checkout and the Customer Portal as plain REST through the outbound client, signed webhooks applied once, and the plan gates groups use. |
| `app/routers/notifications.py`, `app/routers/alerts.py`, `app/services/push.py`, `app/services/alerts.py`, `app/jobs/alert_dispatch.py` | Chunk 1.13: notification settings, encrypted Web Push subscriptions, the device's alert schedule (dates, types, keys), and the dispatch job (`stackd-api dispatch-alerts`) that applies the shared `notify.decide` rule and pushes generic labels only. Fast-follow 6: `app/jobs/weekly_recap.py` schedules the weekly recap by email from the preference (`notification_prefs.channel`: push, email or both; migration 0009) and `dispatch_due` sends it with a link and no numbers; `stackd-api dispatch-alerts` runs that scheduling first. Chunk 2.3: `app/services/push_native.py` (APNs + FCM v1 through `outbound_client`, off per platform without `STACKD_APNS_*` / `STACKD_FCM_SERVICE_ACCOUNT`), the `/push/native` routes, and per-user notification dedupe (migration 0010). |
| `app/services/native_billing.py`, `app/webhooks/apple.py`, `app/webhooks/google.py` | Chunk 2.4: store purchases into the same `subscriptions` table as Stripe. Apple: the transaction / notification JWS must chain to the pinned Apple Root CA G3 bundled next to the service. Google: purchase tokens are verified against the Play Developer API (`STACKD_PLAY_SERVICE_ACCOUNT`), and RTDN is only a hint that triggers that re-verification. `POST /api/billing/native/sync` attaches a verified proof to the signed-in account; account tokens (the user id, set by the app at purchase) let webhooks link rows on their own. |
| `app/routers/account.py`, `app/services/deletion.py` | Chunk 1.11: data export (the server-held part of the device-built ZIP), account deletion (soft delete now, `stackd-api purge-deleted` after `STACKD_DELETION_GRACE_DAYS`), change email with a code to the new address. |
| `app/routers/groups.py`, `app/routers/account.py` | Chunk 1.6: the monthly savings challenge (create for a month, look up and join by `STK-XXXX` code, one percentage per member, leave, owner removes members and regenerates the code) and the display name other members see. Membership rows only; a member's target and deposits stay on their device. |
| `app/services/` | `otp` (hashed codes, attempts, lockout, resend cooldown), `email` (console / smtp / memory), `webauthn` (py_webauthn; challenges stored per device), `sessions` (hashed cookie token, lock window, revoke), `security_alerts` (always-on emails). |
| `app/security/principal.py`, `csrf.py` | `require_session` / `require_unlocked` / `require_step_up` build the `Caller` from the cookie; `same_site_only` refuses cross-site state changes. |
| `app/security/` | Chunk 0.5: `authz` (ownership, 404 for other users' rows), `step_up`, `rate_limit`, `audit`, `headers`, `outbound` (runtime allowlist). How routers must use them: `CLAUDE.md` "Security conventions". |
| `app/cli.py` | `stackd-api migrate [--check]`, `stackd-api init-storage`. |
| `migrations/` | Alembic. Revisions are written by hand and checked against the models by a test. |
| `tests/` | pytest against a real Postgres and a real S3-compatible store (see below). `tests/authz/` and `tests/security/` are the suites `security.yml` runs. |
| `scripts/postgres-init.sql` | Creates `stackd_test` on first start of the compose database. |

Arrives in later chunks: `webhooks/apple.py` and `google.py` (2.4), `routers/linking.py` (Phase 3).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `STACKD_ENV` | `dev` | `dev`, `test` or `prod`. Prod hides docs and refuses `ensure_bucket`. |
| `STACKD_DATABASE_URL` | none | `postgresql+psycopg://user:pass@host:5432/db`; nothing else is accepted. |
| `STACKD_S3_ENDPOINT_URL` | none | MinIO locally; any S3-compatible store in prod. |
| `STACKD_S3_REGION` | `us-east-1` | |
| `STACKD_S3_BUCKET` | `stackd-backups` | Ciphertext only. Tests override to `stackd-test`. |
| `STACKD_S3_ACCESS_KEY`, `STACKD_S3_SECRET_KEY` | none | |
| `STACKD_IP_HASH_KEY` | none | HMAC key for pseudonymous IPs and rate-limit keys. |
| `STACKD_SECRET_KEY` | none | HMAC key for one-time codes and session tokens at rest. |
| `STACKD_RP_ID`, `STACKD_RP_NAME`, `STACKD_ORIGINS` | `localhost`, `Stackd`, `["http://localhost:5173"]` | WebAuthn relying party and allowed origins (JSON list). The RP id must be a domain, never an IP. |
| `STACKD_COOKIE_SECURE` | `false` | `true` in prod (HTTPS only). |
| `STACKD_SESSION_TTL_DAYS`, `STACKD_LOCK_AFTER_SECONDS` | `30`, `300` | Per-device session life; auto-lock after inactivity. |
| `STACKD_VAPID_PRIVATE_KEY`, `STACKD_VAPID_PUBLIC_KEY`, `STACKD_VAPID_SUBJECT` | none, none, `mailto:security@localhost` | Web Push keys (EC P-256 PEM; base64url public point). Push is off without them. |
| `STACKD_STRIPE_SECRET_KEY`, `STACKD_STRIPE_WEBHOOK_SECRET`, `STACKD_STRIPE_PRICE_{PRIVATE,CONNECTED}_{MONTHLY,YEARLY}`, `STACKD_STRIPE_PRICE_FOUNDING` | none | Stripe test or live keys and the five price ids. Billing is off (every plan reads as Free; Checkout and the Portal answer 503) until all seven are set. Only `api.stripe.com` is contacted, through the outbound client; webhooks arrive at `POST /api/webhooks/stripe` and are verified on the raw body. |
| `STACKD_SITE_ORIGIN` | `http://localhost:4321` | The public website (`apps/site`). Only `/api/public/` (the deletion request) answers it cross-origin; https in prod. |
| `STACKD_DELETION_GRACE_DAYS` | `30` | Days between a deletion request and the hard purge (proposed; the privacy policy states the final figure). |
| `STACKD_OTP_*` | `600`, `5`, `900`, `60` | Code TTL, max attempts, lockout, resend cooldown (proposed values). |
| `STACKD_EMAIL_BACKEND`, `STACKD_EMAIL_FROM`, `STACKD_SMTP_*` | `console`, … | `console` prints, `memory` records (tests), `smtp` sends (Mailpit in compose; any provider's relay in prod). |
| `STACKD_STEP_UP_MAX_AGE_SECONDS`, `STACKD_TRUST_PROXY_HEADERS` | `300`, `false` | See chunk 0.5. |

`cp .env.example .env` for local work. Tests ignore `.env` (see below).

## Running locally

**With Docker** (any machine with Docker, OrbStack or Podman), from the repo root:

```bash
docker compose up --build --wait          # Postgres 16, RustFS (S3-compatible), Mailpit, API
curl -s localhost:8000/health/ready        # {"status":"ok","checks":{"db":"ok","migrations":"ok","storage":"ok"}}
docker compose down --volumes
```

The API container runs `stackd-api migrate && stackd-api init-storage` before `uvicorn`. RustFS's console is at <http://localhost:9001>, Mailpit's inbox at <http://localhost:8025>. RustFS replaces MinIO, whose images were withdrawn from Docker Hub and Quay; any S3-compatible store works, only `STACKD_S3_*` change.

**Without Docker**, from Homebrew (`brew install postgresql@16 minio`; MinIO's server binary is still packaged, and any other S3-compatible server on port 9000 works the same):

```bash
# once
pg_ctl -D /opt/homebrew/var/postgresql@16 -l /tmp/pg.log start
createuser stackd && psql -d postgres -c "ALTER ROLE stackd WITH LOGIN PASSWORD 'stackd'"
createdb -O stackd stackd && createdb -O stackd stackd_test

# each session (MinIO keeps its data wherever you point it)
MINIO_ROOT_USER=stackd MINIO_ROOT_PASSWORD=stackd-dev-storage \
  minio server ~/.local/share/stackd-minio --address 127.0.0.1:9000 --console-address 127.0.0.1:9001

# then, in services/api
cp .env.example .env
uv sync
uv run stackd-api migrate
uv run stackd-api init-storage
uv run uvicorn app.main:app --reload --port 8000
```

Stop Postgres with `pg_ctl -D /opt/homebrew/var/postgresql@16 stop`.

## Commands

```bash
uv sync                                       # Python 3.12 from the repo's .python-version
uv run pytest                                 # needs Postgres + an S3-compatible store (above or compose)
uv run pytest tests/authz tests/security      # the suites security.yml runs
uv run pytest -k migrations                   # one file
uv run ruff check . && uv run ruff format --check .
uv run alembic revision -m "<what>"           # new empty revision; then write it by hand
uv run alembic upgrade head | downgrade -1    # or: uv run stackd-api migrate [--check]
uv run stackd-api openapi -o ../../packages/api-client/openapi.json   # OpenAPI snapshot for the typed client
```

## Tests

`tests/_env.py` runs before anything else and pins the environment: `STACKD_ENV=test`, the database from `STACKD_TEST_DATABASE_URL` (default `postgresql+psycopg://stackd:stackd@localhost:5432/stackd_test`), bucket `stackd-test`. Explicit environment variables beat `.env`, and the run aborts unless the database name ends in `_test`, so a dev database is never dropped. The `migrated` fixture rebuilds the schema from `base` to `head` for the session.

CI (`.github/workflows/ci.yml`) provides a Postgres service container and a RustFS container for this job, and a second job runs `docker compose up --wait` at the repo root and asserts `/health/ready` and `stackd-api migrate --check`, which is the spec's "done when" for chunk 0.4.

## Conventions

- **Migrations are hand-written** from the models, with the naming convention in `app/models/base.py` (`pk_`, `uq_`, `ck_`, `fk_`, `ix_`). `tests/test_migrations.py::test_models_and_migrations_agree` runs Alembic's autogenerate comparison and fails on any drift, in either direction.
- **Sync SQLAlchemy** (`def` endpoints, FastAPI's threadpool). The server is thin by design; this keeps sessions, Alembic and tests simple.
- **Enumerations are CHECK constraints**, not Postgres enum types, so a new value is one migration line.
- **Readiness never leaks detail.** `/health/ready` answers with one word per check; the traceback goes to the log.
- **Outbound hosts** must be in `tools/network_allowlist.txt` (static scan in CI). Runtime enforcement lands in 0.5.
