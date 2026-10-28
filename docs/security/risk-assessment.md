# Risk assessment

*Version 1.1, effective October 16, 2026 (first adopted October 13, 2026). Owner: the Director of Qash Solutions Inc. Next scheduled review: October 2027, and sooner after any incident, a new vendor, or a change to what the server stores.*

## Method

Likelihood and impact are each rated 1 (low), 2 (medium) or 3 (high). Risk = likelihood × impact: **1–2 low, 3–4 medium, 6–9 high**. "Residual" is the rating with the listed controls in place. Highs must have an owner and a dated plan; nothing launches with an open high.

## Register

| # | Risk | L | I | Controls (chunk) | Residual | Status |
|---|---|---|---|---|---|---|
| 1 | Account takeover through an intercepted or phished one-time code | 2 | 3 | Passkey required at sign-up and for unlock, so a code alone opens nothing (1.2); step-up before sensitive actions (0.5); always-on alerts on new sign-in; OTP rate limits (0.5) | 2 low | controls in place from 1.2 |
| 2 | A bug lets one user read or change another's server data | 2 | 3 | `authz` helpers on every router; cross-user tests in `tests/authz` on every PR (0.5); 404 not 403; group data is % progress only | 2 low | in place |
| 3 | Statements, receipts or transactions reach the server by mistake | 1 | 3 | Local-first design; the API has no table or route for them; network allowlist; code review rule in `CLAUDE.md` | 1 low | in place |
| 4 | A secret is committed to the public repository | 2 | 3 | `.env` ignored; no default secrets in code (0.4); gitleaks over the whole history on every PR and weekly (0.5); rotate on exposure | 2 low | in place |
| 5 | A vulnerable dependency ships | 3 | 2 | Locked installs; pip-audit and pnpm audit on every PR and weekly (0.5); small dependency set; patch deadlines by severity and a quarterly end-of-life review (security plan, "Vulnerability and patch management") | 2 low | in place |
| 6 | An AI or LLM package or call slips in | 1 | 3 | Denylist with self-test in CI (0.1); outbound allowlist static and runtime (0.1, 0.5) | 1 low | in place |
| 7 | Abuse of code sends (mail bombing a victim, running up email cost) | 3 | 2 | Rate limits per IP and per email (0.5, 1.2); provider sending limits | 2 low | in place |
| 8 | Invite-code guessing joins a stranger to a group | 2 | 2 | Long random codes; join rate limit (0.5); owner can remove members; no amounts or emails shown (1.6) | 1 low | in place |
| 9 | User loses device data (browser clears storage, phone lost) with no backup | 3 | 2 | Persistent-storage request, install prompt, export reminders (1.3); encrypted backup on paid plans (1.16); linked accounts refill from the bank on Connected | 2 low | in place |
| 10 | User loses the backup key and recovery key | 2 | 2 | Plain warning at setup; recovery key to save; restore by passkey or recovery key, tested (1.16) | 2 low | in place |
| 11 | Production database or storage breach at the provider (AWS) | 1 | 3 | Encryption at rest; minimal server data; backups are ciphertext; bank tokens encrypted under a separate key; vendor review (`vendors.md`); breach plan (`incident-response.md`) | 2 low | in place by design; AWS review in `vendors.md` |
| 12 | Staff or admin credential compromise | 1 | 3 | AWS root has multi-factor authentication and no access keys; people reach AWS only through IAM Identity Center with a passkey at every sign-in and short-lived credentials, no long-lived personal AWS keys (October 16, 2026); two-factor sign-in on GitHub, the owner's Gmail, ImprovMX and Stripe (confirmed October 13, 2026); unused access keys deleted; least privilege for new roles; AWS actions recorded by the CloudTrail trail (13 months); root activity and IAM changes email the owner at once; budget and cost-anomaly alerts | 2 low | in place (October 13, 2026) |
| 13 | Stripe webhook forgery changes a plan | 1 | 2 | Signature verified on every event; idempotent handling; plan changes audited and alerted (1.14) | 1 low | in place |
| 14 | Denial of service exhausts the API or email budget | 2 | 2 | Rate limits; AWS Shield Standard DDoS protection on CloudFront (automatic); SES sending quotas; the app keeps working offline for viewing and logging | 2 low | in place |
| 15 | Push payload or alert reveals money details | 1 | 2 | Alert schedule carries date, type and generic label only; no amounts or merchants, by schema (0.4+) | 1 low | in place by design |
| 16 | Legal misclassification (GLBA, state privacy or auto-renewal law) | 2 | 2 | A one-time legal review before launch; Safeguards Rule elements adopted regardless; cancellation in the app in two taps | 2 low | open: legal review before launch |
| 17 | Cross-site scripting in the PWA reads device data | 2 | 3 | React escaping; no third-party scripts (Plaid runs on its own hosted page); separate origin from the website; dependency audits; a strict CSP on the app's CloudFront distribution, set when it is created | 2 low | in place; CSP with the app deployment |
| 18 | Insider misuse by a contributor | 1 | 3 | Code reviewed in pull requests with CI gates; merging only after every check passes is our own rule, checked at each access review against `main`'s history (enforced by GitHub branch protection since October 27, 2026: pull requests only, the required gate checks, up to date with `main`, administrators included; by process October 16–27); deploys run only after every check on `main` passes; no production data in development; audit log | 1 low | in place (enforced by GitHub since October 27, 2026) |
| 19 | A Plaid access token is stolen and used to read a user's bank data | 1 | 3 | Tokens encrypted at rest under a dedicated key, decrypted only inside the request that calls Plaid, never logged or sent to the device; read-only products only (no money movement, no account numbers); revoked on disconnect, account deletion and after 60 days unused; key rotation and mass revoke in `incident-response.md` (3.2–3.4) | 2 low | in place |
| 20 | A forged Plaid webhook changes a connection | 1 | 2 | ES256 signature against Plaid's published key, 5-minute age limit, hash of the exact body; webhooks only set flags and carry no data (3.3) | 1 low | in place |
| 21 | Linked transactions or card details end up stored on the server | 1 | 3 | Pass-through by design: no table or column holds them, checked by a test; the device keeps the sync cursor (3.3, 3.5) | 1 low | in place |
| 22 | An AI service is used by mistake (hard constraint 2) | 1 | 2 | Package denylist in CI; outbound allowlist; IAM policy `qash-deny-bedrock` denies every Bedrock call in the AWS account (October 12, 2026) | 1 low | in place |
| 23 | Mail to `security@` or `support@qash.solutions` is lost, or the domain is spoofed | 2 | 2 | MX records forward through ImprovMX to the owner's inbox; SPF published; SES signs outgoing mail with DKIM and a custom MAIL FROM; DMARC published, `p=quarantine` since October 27, 2026 | 1 low | in place (October 13, 2026) |
| 24 | Linking cost or exposure grows from connections nobody uses | 2 | 1 | Connections unused for 60 days are revoked automatically and the user is told (3.4); at most 3 per Connected account | 1 low | in place |
| 25 | The tester tools are used to get a plan without paying | 1 | 1 | Only emails in the production secret `STACKD_ADMIN_EMAILS` (not in the repository, not settable from the app); the route answers 404 for anyone else and a stored tester plan is ignored once the email is removed; own account only; passkey check, audit `tester:<plan>` and the always-on email on every switch (October 18, 2026) | 1 low | in place |

## Open highs

None, and no mediums. No open lows with work left.

## Restore tests

No restore test yet: the production database is created with the API deployment. The first restore test runs before launch, then every quarter; each one is recorded here with its date, what was restored, the result and who ran it.

## Access reviews

| Date | Scope | Result | By |
|---|---|---|---|
| 2026-10-13 | AWS (every region: databases, snapshots, servers, secrets, functions, container registries, storage buckets; IAM users and access keys), GitHub, Stripe, Gmail, ImprovMX | No leftover resources in any region; both storage buckets block public access; multi-factor sign-in confirmed on every account; one unused, inactive IAM access key (February 2026) deleted | Director, Qash Solutions Inc. |
| 2026-10-16 | AWS people and keys | IAM Identity Center enabled (one user, passkey at every sign-in, AdministratorAccess with 4-hour sessions); the admin IAM user's access key and console password removed; IAM users left: the API's send-only email user (one active key), the owner's email-reply user (key inactive) and the former admin user (no key, no password); the backup bucket has one active access key for the API | Director, Qash Solutions Inc. |

## Review log

| Date | Change | By |
|---|---|---|
| 2026-10-10 | First draft with chunks 0.1–0.5 in place | Claude Code, for the security owner |
| 2026-10-13 | Stripe two-factor sign-in confirmed; the unused February 2026 access key on the admin IAM user deleted (risk 12) | Director, Qash Solutions Inc. |
| 2026-10-13 | Two-factor sign-in confirmed on GitHub, Gmail and ImprovMX (risk 12) | Director, Qash Solutions Inc. |
| 2026-10-13 | Branch protection on `main` switched on; risk 18 closed | Director, Qash Solutions Inc. |
| 2026-10-16 | Repository made private; GitHub no longer enforces branch protection on our plan, so pull requests only and every check before merge are kept by process (risk 18) | Director, Qash Solutions Inc. |
| 2026-10-16 | AWS administration moved to IAM Identity Center; no long-lived personal AWS keys (risk 12) | Director, Qash Solutions Inc. |
| 2026-10-16 | The email-reply user's exposed key (switched off earlier that day) deleted and a new one created for Gmail's "Send mail as"; it can still only send from `@qash.solutions` (risks 4 and 23) | Director, Qash Solutions Inc. |
| 2026-10-19 | Checked in the IAM console: the exposed key no longer exists; IAM users are the former admin (no key, no password), `qash-api-ses` (the app's sender, one active key) and `qash-ses-smtp` (the reply login, one active key made after the exposure, not in the exposed file). The overwritten commit from that day is reachable from no branch or tag, but GitHub keeps it for the pull request's history; GitHub Support was asked to purge it, and the repository stays private until that is confirmed (risk 4) | Director, Qash Solutions Inc. |
| 2026-10-20 | pip-audit flagged certifi 2026.7.22 (GHSA-6q48-6c7w-9gw2: a revoked root CA in the bundle the API trusts for outbound TLS to Plaid, Stripe and SES); updated to 2026.10.19 the same day, before any deploy carried it (risk 4) | Claude Code, for the security owner |
| 2026-10-23 | pnpm audit flagged two high advisories reachable only through Astro, which builds the static website (nothing shipped to visitors or the app): zod < 4.6.6 (GHSA-mrhx-c7xc-m3w5, memory exhaustion) fixed by Astro 7.4.2, and undici 8.0.0–8.12.1 (denial of service on excessive content-encodings) overridden to ^8.12.2 in pnpm-workspace.yaml until Astro's unifont updates; patched the same day, before any deploy carried them | Claude Code, for the security owner |
| 2026-10-27 | Both SES send-only users' keys rotated (GitHub had not yet purged the October 16 commit; that key was already deleted): new key made, the app and Gmail switched and tested, old keys deleted; `denaliadmin` no longer exists, so the IAM users are `qash-api-ses` and `qash-ses-smtp`, one key each. DMARC moved from `p=none` to `p=quarantine` after SPF, DKIM and DMARC were seen passing (risk 23) | Director, Qash Solutions Inc. |
| 2026-10-27 | Repository restarted as a fresh public `qashsolutions/myfinapp` (one starting commit) after every exposed key was rotated; the earlier history archived privately as `myfinapp_old_pvt` (risk 4) | Director, Qash Solutions Inc. |
| 2026-10-27 | Risk 18's control lapsed once: PR #3 was merged while one check (Python lint, six over-long comment lines) was failing, because the merge script's check-for-failures step misread the result. Nothing reached production: the deploy waits for every check on `main`, which failed, and production stayed on the previous build. PR #4 fixed the lines; merges are now gated on a count of non-passing checks. Switching on GitHub's branch protection would enforce the rule | Claude Code, for the security owner |
| 2026-10-27 | Branch protection on `main` switched on again at the owner's request: pull requests only; required checks `every CI check passed`, `every security check passed` and `guards (no AI packages · allowlisted hosts · contrast)`; up to date with `main`; no force pushes or deletion; administrators included (risk 18) | Director, Qash Solutions Inc. |
| 2026-10-18 | Risk 25 added for the tester tools | Director, Qash Solutions Inc. |
| 2026-10-13 | Version 1.0: statuses brought up to date; risks 19–24 added for bank and card linking, AWS, email and AI services | Director, Qash Solutions Inc. |
