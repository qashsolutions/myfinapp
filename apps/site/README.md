# @stackd/site

The public website (docs/spec.md "Phase 1W"): static HTML from Astro in the Modern look, reusing `@stackd/tokens` and the self-hosted Outfit font. No client framework, no image service, no analytics, nothing loaded from a third party.

Pages: `/` (landing), `/how-it-works`, `/pricing` (Free / Private / Connected with the yearly / monthly toggle, the Founding member offer, renewal and cancel terms before purchase), `/security` (plain-language security and "data we never collect"), `/privacy` and `/terms` (a plain-language summary first; a full section appears only once it has text, so no placeholder is shown), `/delete-account` (the public deletion request: a code to the account's email, then the same soft delete as in-app deletion), `/support` (FAQ and a contact form that opens the mail app), `/licenses` (generated), `/404`, and `/.well-known/security.txt`.

```bash
pnpm -C apps/site dev                 # http://localhost:4321
pnpm -C apps/site build               # dist/ (static; ASTRO_TELEMETRY_DISABLED)
pnpm -C apps/site test                # builds, then checks every page: title, description, one h1, skip link, legal footer, no third-party resources; prices and limits against services/api/app/rules_server/plans.yaml
pnpm -C apps/site run licenses:build  # regenerates src/data/licenses.json from pnpm's listing and the API's installed packages
```

Configuration (build-time, `PUBLIC_*` so Astro exposes them): `PUBLIC_SITE_URL` (this site's origin, for canonical links), `PUBLIC_APP_URL` (the PWA, default `https://app.qash.solutions`), `PUBLIC_API_URL` (the API the deletion page posts to, default the app's origin). The API must list this site's origin in `STACKD_SITE_ORIGIN`; only `/api/public/` answers it.

`LEGAL_UPDATED`, `DELETION_DAYS` and the Founding limit (`cap`, shown only when set) live in `src/data/site.ts` and `src/data/plans.ts`; the full legal sections are added as `text` on each section of the two legal pages. Copy follows docs/spec.md; where the website mockup lags the spec (PDF statements, Connected "coming soon"), the spec wins.

Biome does not parse `.astro` files; the Astro compiler checks them at build. Lighthouse is not run in CI (no browser there); the pages are static HTML with one small script on pricing and delete-account, so performance and accessibility ≥ 90 is expected, and should be confirmed once the site is deployed.
