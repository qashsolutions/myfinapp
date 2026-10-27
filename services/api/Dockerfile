# syntax=docker/dockerfile:1
# Qash API image. Built by docker-compose.yml at the repo root and by CI, with the repo root as
# the build context: the API depends on services/rules by path (../rules).
#
# Two stages (October 13, 2026): `build` installs the dependencies with uv; the final image
# copies only the finished virtual environment and the source, so build tools such as uv never
# ship to production (fewer packages to patch, and nothing an attacker could reuse to install
# code). Trivy scans this image in CI (security.yml).

FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.17 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /srv/api

# The shared rules package, at the path pyproject.toml points to (../rules).
COPY services/rules /srv/rules

# Dependencies first so source edits do not invalidate the dependency layer.
COPY services/api/pyproject.toml services/api/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY services/api .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Same paths as the build stage, so the virtual environment's links stay valid.
COPY --from=build /opt/venv /opt/venv
COPY --from=build /srv/rules /srv/rules
COPY --from=build /srv/api /srv/api
WORKDIR /srv/api

RUN useradd --system --uid 10001 --create-home api && chown -R api:api /srv/api
USER api
EXPOSE 8000

# The `api` container brings the schema up to date, then serves. The `jobs` container runs the
# same image with the command `stackd-api jobs-loop` (docs/ops/aws-hosting.md, step D).
CMD ["sh", "-c", "stackd-api migrate && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-server-header"]
