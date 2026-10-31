#!/bin/sh
# The load test's API: the stackd_load database, port 8200, started the way the Dockerfile
# starts production (one uvicorn process). Proxy headers are trusted so each simulated person
# has their own address, as CloudFront-Viewer-Address gives in production. Prints no secrets.
set -e
cd "$(dirname "$0")/.."
base=$(grep '^STACKD_DATABASE_URL=' .env | cut -d= -f2-)
export STACKD_DATABASE_URL="${base%/*}/stackd_load"
export STACKD_TRUST_PROXY_HEADERS=true
export STACKD_S3_BUCKET=stackd-load
export STACKD_EMAIL_BACKEND=memory
export PYTHONUNBUFFERED=1
uv run stackd-api init-storage >/dev/null
if [ -n "$LOAD_PROFILE" ]; then exec uv run --with yappi python loadtest/profile_api.py; fi
exec uv run uvicorn app.main:app --host 127.0.0.1 --port "${LOAD_API_PORT:-8200}" --no-server-header ${LOAD_UVICORN_ARGS:-}
