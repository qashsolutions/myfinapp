# Vendor review

*Version 1.1, effective October 16, 2026 (first adopted October 13, 2026). Owner: the Director of Qash Solutions Inc. Re-reviewed when a vendor is added or changed, and yearly (next: October 2027).*

docs/spec.md "Security program": review the security and data handling of hosting, email, push and payment providers. A vendor is approved when every column is filled, the data it receives is the minimum the feature needs, and the security owner has signed. Until then the row says **to review**.

## Register

| Role | Provider | Data it receives | How we authenticate to it | Terms / DPA | Status | Last reviewed |
|---|---|---|---|---|---|---|
| Source hosting + CI | GitHub (`qashsolutions/myfinapp`) | Source code, CI logs. Never secrets: CI secrets live in repository settings | Account `qashsolutions` with two-factor sign-in; public repository since October 27, 2026 (a fresh history; the earlier history stays in the private archive `myfinapp_old_pvt`, never made public, Actions off); every push is public at once, so diffs are scanned for secrets and personal details first and gitleaks runs on every PR; changes reach `main` only through pull requests after every CI check passes (our own rule) | GitHub terms | in use | 2026-10-27 |
| Cloud hosting: DNS, website, app, API, database, object storage, certificates | Amazon Web Services (Route 53, CloudFront, S3, Lightsail containers, Lightsail PostgreSQL and bucket, Certificate Manager), account of Qash Solutions Inc. | Everything the server holds (see `SECURITY.md`): account, plan, % progress, alert schedule, ciphertext backups, encrypted Plaid tokens | Root user with multi-factor authentication and no access keys; people administer through IAM Identity Center with a passkey at every sign-in and short-lived credentials (since October 16, 2026; no person holds an access key); deploys through the least-privilege role `qash-deploy` assumed by GitHub Actions over OIDC (no stored keys); IAM policy `qash-deny-bedrock` blocks AI services | AWS Customer Agreement; AWS GDPR Data Processing Addendum is part of the service terms | in use (API, database and storage deployed October 13, 2026) | 2026-10-16 |
| Transactional email (sign-in codes, security alerts, weekly recap) and the owner's replies as support@ | Amazon SES | Email address, one-time codes, alert text with no amounts | Domain verified with DKIM, custom MAIL FROM and DMARC; send-only IAM user `qash-ses-smtp` for the owner's replies (its key was exposed on October 16, 2026, switched off within minutes and deleted; a new key was made the same day and is held only in the owner's Gmail "Send mail as" setting; both send-only users' keys were rotated again on October 27, 2026, old keys deleted); the app sends as `no-reply@` through its own send-only user `qash-api-ses` | AWS terms (as above) | in use (verified October 13, 2026) | 2026-10-13 |
| Inbound mail forwarding for `@qash.solutions` (support, privacy, security) | ImprovMX | Messages sent to those addresses, forwarded to the owner's inbox | MX and SPF records in Route 53; account held by the owner, with two-factor sign-in | ImprovMX terms | in use | 2026-10-13 |
| Owner's inbox | Google (Gmail) | The forwarded messages above; vendor accounts (Plaid, ImprovMX) | Owner's Google account with two-step verification | Google terms | in use | 2026-10-13 |
| Web Push | Browser vendors (Google FCM, Mozilla, Apple, Microsoft) via VAPID | Push endpoint; payload is a type and a generic label only | VAPID key pair from the secret store | Platform terms; no contract | in use (built) | 2026-10-13 |
| Payments | Stripe (Checkout, Customer Portal, webhooks) | Email, plan, payment details (held by Stripe, never by us) | Dashboard account with multi-factor sign-in; restricted API key; webhook signing secret verified on every event | Stripe terms; PCI handled by Stripe hosted pages | built; account and keys to set up | 2026-10-13 |
| Bank and card data (Connected plan) | Plaid (Transactions + Liabilities; see `linking.md`) | Read-only transactions, balances and card statement details, passed through to the device and not stored; the institution name; a revocable access token encrypted server-side | Client id and secret from the secret store; access tokens encrypted under `STACKD_LINK_TOKEN_KEY` | Production application in progress (October 13, 2026); terms and data agreement to sign; list price $0.30 (Transactions) + $0.20 (Liabilities) per connection per month | sandbox; production pending approval | 2026-10-13 |
| Error reporting / analytics | none | None: no analytics or error-reporting service is used. Any later choice must be self-hosted or anonymised (docs/spec.md "Privacy"); no ad SDKs | n/a | n/a | not used | 2026-10-13 |

## Review checklist (per vendor)

1. What data does it receive, and is each field needed by the feature?
2. Encryption in transit and at rest; where the data is stored; retention and deletion on our request.
3. How we authenticate: least privilege, per-environment, rotatable, kept in the secret store.
4. The vendor's own posture: SOC 2 or ISO 27001 report, breach-notification commitment, sub-processors.
5. What happens if it is down or gone: can we switch, and what do users lose meanwhile?
6. Legal: DPA signed, terms read by the security owner, privacy policy lists the vendor where required.
