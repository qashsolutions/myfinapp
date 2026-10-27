#!/bin/sh
# The payments e2e stack (October 24, 2026): the e2e API (stackd_e2e, :8100) with Stripe's test
# keys from services/api/.env, and `stripe listen` forwarding real, signed test-mode webhooks to
# it under the secret it prints. Refuses anything but a test key. Prints no secrets.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/../../../services/api"
key=$(grep '^STACKD_STRIPE_SECRET_KEY=' .env | cut -d= -f2-)
case "$key" in sk_test_*|rk_test_*) ;; *) echo "refusing: not a Stripe test key" >&2; exit 1 ;; esac
base=$(grep '^STACKD_DATABASE_URL=' .env | cut -d= -f2-)
export STACKD_DATABASE_URL="${base%/*}/stackd_e2e"
export STACKD_EMAIL_BACKEND=console
export STACKD_ORIGINS='["http://localhost:5174"]'
export STACKD_RP_ID=localhost
export STACKD_ADMIN_EMAILS='["e2e-owner@example.com"]'
export PYTHONUNBUFFERED=1
STACKD_STRIPE_WEBHOOK_SECRET=$(stripe listen --api-key "$key" --print-secret)
export STACKD_STRIPE_WEBHOOK_SECRET
events=checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,charge.dispute.created,charge.dispute.closed,radar.early_fraud_warning.created
out="$here/../e2e/.output"
# The listener prints its signing secret: masked before it reaches the log.
stripe listen --api-key "$key" --events "$events" \
  --forward-to http://127.0.0.1:8100/api/webhooks/stripe 2>&1 \
  | sed -l -E 's/whsec_[A-Za-z0-9]+/whsec_(masked)/g' > "$out/stripe.log" &
trap 'kill 0' EXIT INT TERM
uv run stackd-api migrate >/dev/null
uv run uvicorn app.main:app --port 8100
