# Stackd

A mobile-first PWA that helps people keep more of what they earn: see money in and out, budget, build an emergency fund, and hit savings goals solo or with a group. Everything about money is computed by deterministic rules on the user's own device. No AI, no bank linking at launch, no money movement.

"Stackd" is a placeholder name.

## Where things are

| Path | What |
|---|---|
| `docs/spec.md` | The build spec. Source of truth for scope, data model, rules and the chunked build plan. |
| `docs/design-handoff/` | Design tokens, mockup markup and rendered previews. Its README lists where mockups lag the spec. |
| `docs/decisions/` | Architecture decision records. |
| `docs/security/` | Security owner, vulnerability reporting, written security plan, risk assessment, incident response, vendor review. Root `SECURITY.md` points here. |
| `tools/` | CI guards: AI-package denylist, backend network allowlist, WCAG contrast. |
| `packages/tokens/` | Design tokens → CSS variables and typed data, all looks and modes. |
| `apps/mobile/` | Capacitor shells for iOS and Android around the `apps/web` build (Phase 2). |
| `services/rules/` | `stackd_rules`: every money formula, pure and versioned, with golden tests. Source of truth. |
| `packages/rules/` | The TypeScript port of the rules that runs on the device; CI keeps it identical. |
| `services/api/` | The thin FastAPI server: accounts, plans, group progress, alert schedule, ciphertext backups. |
| `packages/ui/` | Shared React components, one implementation for every look. |
| `apps/web/` | The PWA: app shell, theme, tab bar and side rail, manifest and service worker, sign-in with email code + passkey, lock screen, security settings; feature screens arrive chunk by chunk. |
| `packages/api-client/` | Typed client generated from the API's OpenAPI document (`pnpm api:schema`). |
| `docker-compose.yml` | Local Postgres, RustFS (S3-compatible), Mailpit and the API. |
| `CLAUDE.md` | Constraints and conventions for Claude Code sessions. |

## Prerequisites

- Node 24 (see `.nvmrc`) and pnpm 11 (`corepack enable` or install pnpm; version pinned in `package.json`).
- [uv](https://docs.astral.sh/uv/) for Python; it installs Python 3.12 from `.python-version` on first use.
- Docker (or OrbStack / Podman) for `docker compose up`. Without it, Homebrew `postgresql@16` and `minio` work too; see `services/api/README.md`.

## Commands

```bash
pnpm install              # TypeScript workspaces
pnpm dev                  # the PWA at http://localhost:5173 (builds tokens first)
pnpm lint                 # Biome, whole repo
pnpm typecheck            # tsc per package, via Turborepo
pnpm test                 # Vitest per package, via Turborepo
pnpm build                # tokens, then the PWA (apps/web/dist with manifest + service worker)
pnpm guards               # the three CI guards, locally

cd services/rules && uv sync && uv run pytest        # golden tests
cd services/api && uv sync && uv run pytest          # API tests; needs Postgres + an S3-compatible store running
docker compose up --build --wait                     # API + Postgres + RustFS + Mailpit, then localhost:8000/health/ready
```

CI runs the same steps in `.github/workflows/ci.yml` and `guards.yml` on every pull request, plus `security.yml` (dependency audit, secret scan, cross-user access tests).

## Hard constraints

Six non-negotiables from the spec. A PR that breaks one must fail CI.

1. Deterministic: same inputs and rule version, same output; `as_of` is always passed in.
2. No AI or LLM API calls, client or server. Enforced by `tools/check_ai_denylist.py`.
3. No bank linking at launch; never bank passwords, never money movement.
4. PWA first; code never assumes a native shell.
5. Store-ready from day one: in-app deletion, web deletion page, full export, privacy and terms links.
6. Plain language; nothing is financial advice.

Plus local-first: statements, receipts and transactions live only on the device.
