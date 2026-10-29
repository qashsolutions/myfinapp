#!/bin/sh
# Close an e2e account the way the plan lifecycle does 7 days after a plan ends
# (deletion.soft_delete(plan_ended=True)), without waiting a week. Same database as
# start-api.sh; prints no secrets. Usage: sh e2e/close-account.sh <email>
set -e
cd "$(dirname "$0")/../../../services/api"
if [ -f .env ]; then
  base=$(grep '^STACKD_DATABASE_URL=' .env | cut -d= -f2-)
  export STACKD_DATABASE_URL="${base%/*}/${E2E_DB:-stackd_e2e}"
fi
export STACKD_EMAIL_BACKEND=console
export STACKD_ORIGINS="[\"http://localhost:${E2E_WEB_PORT:-5174}\"]"
export STACKD_RP_ID=localhost
uv run python - "$1" <<'PY'
import sys

from sqlalchemy import select

from app.db import get_session_factory
from app.models.user import User
from app.services.deletion import soft_delete

with get_session_factory()() as db:
    user = db.scalars(select(User).where(User.email == sys.argv[1])).one()
    soft_delete(db, user, plan_ended=True)
    db.commit()
PY
