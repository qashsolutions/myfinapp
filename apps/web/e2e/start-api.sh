#!/bin/sh
# The e2e stack's API: its own database (stackd_e2e) and port (8100), email printed to a log the
# tests read for sign-in codes. Reuses services/api/.env for everything else; prints no secrets.
set -e
cd "$(dirname "$0")/../../../services/api"
# On the Mac: services/api/.env, with the database swapped for stackd_e2e. In CI there is no .env:
# the job sets every STACKD_* itself (development values, no real keys) and storage is made here.
if [ -f .env ]; then
  base=$(grep '^STACKD_DATABASE_URL=' .env | cut -d= -f2-)
  export STACKD_DATABASE_URL="${base%/*}/stackd_e2e"
fi
export STACKD_EMAIL_BACKEND=console
export STACKD_ORIGINS='["http://localhost:5174"]'
export STACKD_RP_ID=localhost
export PYTHONUNBUFFERED=1
uv run stackd-api migrate >/dev/null
if [ -n "$CI" ]; then uv run stackd-api init-storage >/dev/null; fi
exec uv run uvicorn app.main:app --port 8100
