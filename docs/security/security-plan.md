# Information security policy and plan

*Version 1.3, effective October 27, 2026 (first adopted October 13, 2026). Owner and approver: the Director of Qash Solutions Inc. Reviewed yearly (next: October 2027) and after any architecture change, incident or new vendor. Whether the FTC Safeguards Rule (GLBA) applies is part of a one-time legal review before launch; its core elements are adopted either way (docs/spec.md "Security program").*

## 1. Policy statement, purpose and scope

Qash (qash.solutions), operated by Qash Solutions Inc., helps people see and plan their money. People trust it with their spending habits, debts, goals and, on the Connected plan, read-only access to their bank and card accounts. Qash Solutions Inc. protects that information by identifying the risks to it, putting controls in place to reduce them, and monitoring that the controls keep working. This document is the policy and the plan that does that.

It applies to the web app (PWA), the API, the website, this repository, CI, the AWS account that hosts them, and every vendor in `vendors.md`. Everyone who works on Qash follows it. The design removes whole classes of risk: money data stays on the user's device, the server runs no AI, and linking is read-only and moves no money. This plan covers the rest.

**Operating this policy.** Risks are identified and rated in `risk-assessment.md`; each has controls (section 4) and an owner. The controls are enforced in code and checked automatically on every change (section 6), so they cannot silently lapse. Security events are logged and monitored (section 4, "Logging and monitoring"). Incidents follow `incident-response.md`; vendors are reviewed in `vendors.md`. The security owner reviews the whole set yearly and signs the review log. An exception to this policy needs the security owner's written approval, with a reason and an end date, recorded in `risk-assessment.md`.

## 2. Roles

| Role | Who | Does |
|---|---|---|
| Security owner (the "qualified individual") | The Director of Qash Solutions Inc. (security@qash.solutions); named and signed on the company's signed copy | Owns this plan, the risk assessment, incident response, vendor reviews; approves security-relevant changes |
| Deputy | None yet: the security owner covers this role until one is appointed | Acts when the owner is unavailable |
| Legal review | A one-time outside review before launch, arranged by the security owner | Privacy policy, terms, breach-notification duties, state law applicability |
| Every contributor | | Follows the conventions in `CLAUDE.md`; never commits secrets; never widens data collection without a spec change |

## 3. Data inventory and classification

| Class | Examples | Where it lives | Protection |
|---|---|---|---|
| **Device-only** | Statements, receipt photos, transactions, budgets, goals, forecasts, computed results | IndexedDB on the user's device | Never sent to the server (hard rule, enforced by code review and the network allowlist). Export and encrypted backup are the user's safety nets |
| **Server, personal** | Email, display name, passkey public keys, sessions, plan, group membership with % progress and the member's own "What helped" answer (up to 3 ids from a fixed list; others see totals only, from 2 answers), alert schedule (date, type, generic label; a budget alert key holds a month, a 16-letter tag and a level, never a category or amount), notification preferences | PostgreSQL | TLS, encryption at rest, row-level ownership checks (`app/security/authz.py`), audit log |
| **Server, opaque** | End-to-end encrypted backups | Object storage | Ciphertext only; the key never leaves the user's devices. The newest 3 plus each of the previous 7 days' newest are kept, so bad uploads from a stolen session cannot push out every good copy |
| **Server, linked accounts (Connected only)** | Per bank or card connection: the Plaid access token, Plaid item id, institution name, status and dates | PostgreSQL | The token is encrypted (Fernet) under a key used for nothing else (`STACKD_LINK_TOKEN_KEY`), decrypted only inside the request that calls Plaid, never logged or sent to the device, revoked at Plaid on disconnect, account deletion, or 60 days unused (`linking.md`) |
| **Passed through, never stored** | Linked transactions, balances and card statement details | In memory for one request, then on the user's device | The server returns them to the device and keeps nothing; a test checks no table can hold them |
| **Secrets** | Database and storage credentials, IP-hash key, session key, VAPID keys, Stripe keys and webhook secret, Plaid client id and secret, the link-token key, email credentials | Managed secret store, injected as environment | Never in the repository or the client bundle; `security.yml` secret scan; rotated on any suspected exposure |
| **Operational** | Audit log (actor, action, target, pseudonymous IP, time), rate-limit counters, server logs | PostgreSQL, log sink | No amounts, merchants or receipt contents, by schema design |

## 4. Controls

### Identity and access (users)

- Sign-up is email one-time code **plus** a passkey; there are no passwords (chunk 1.2). After that, a returning user can sign in with the passkey alone (October 13, 2026): the device asks for Face ID, Touch ID, fingerprint or its passcode (user verification is required), the passkey only works on `app.qash.solutions` (phishing-resistant), each challenge is single-use and expires in 5 minutes, attempts are rate-limited, and the same new-sign-in alert and audit entry follow. A device without the passkey uses the email code, then the passkey. Every email code is bound to what it was sent for (October 23, 2026): a sign-in code, an email-change code (sent only after a passkey check, and good only for the account that asked) and a website deletion code are hashed with their purpose, so one never works for another.
- **Link with your phone** (owner decisions, October 19, 2026; server routes `/api/auth/link/*`; the computer's screen `/signin/phone` and the phone's `/link`, whose scanner reads codes on the device and accepts only this app's own `/link` address): a computer that holds no passkey asks for a link and shows an 8-character code (a QR code of it); a phone that is signed in, unlocked and has just passed a passkey check (step-up) approves it, and the computer then picks up a session for that account once, through an HttpOnly cookie only it holds. Only keyed hashes of the code and of that cookie are stored; requests expire after 2 minutes and each is answered once, approved or denied, then closed (a second answer, or one after expiry, is refused and changes nothing; owner decision, October 28, 2026); at most 3 requests an hour per IP, with limits on lookups (code guessing) and status checks; the approval screen names the requesting browser and system, and when the phone and the computer are on different networks (/24 or /64) it warns and the person must confirm. Every approval is audited (`device_link_approved`) and sends the always-on "your phone approved a sign-in" email. **Trade-off:** the browser's own phone sign-in proves the phone is nearby over Bluetooth, which makes it phishing-resistant; linking by camera does not. Sign-in is therefore described as a passkey, or approval by a phone that holds one; the computer is then offered its own passkey.
- The app locks after a period of inactivity the user chooses, 5 to 60 minutes (default 5); the server enforces the same window; unlocking needs the passkey.
- Auto-lock: the app locks after the person's chosen idle window (5 to 60 minutes) and the server enforces the same window. Only what the person does counts as activity (owner decision, October 28, 2026): calls the app makes on its own (syncs, timers, the alert schedule, refreshes) carry `X-Qash-Background: 1`, and the server, like a request another site or a page load makes (`Sec-Fetch-Site` not `same-origin`, `Sec-Fetch-Mode: navigate`), serves them but never counts them; when the app's screen locks it tells the server (`POST /api/auth/lock`), and the session stays locked there until the next passkey check.
- Step-up: a fresh passkey check before export, deletion, email change, plan change, bank linking, adding a passkey once one exists (the first is part of sign-up, after the email code; October 23, 2026), removing a passkey or device, replacing the backup key or turning backup off (both also send an always-on email; October 24, 2026), and changing the auto-lock (`app/security/step_up.py`; window `STACKD_STEP_UP_MAX_AGE_SECONDS`, 5 minutes).
- Always-on security alerts for new sign-in or device, new passkey, export, email change, deletion, plan change, bank connect or disconnect. Users cannot turn these off.
- Users see every signed-in device with its sign-in time, last activity and status (current, active, signed out, signed out from another device, expired), can sign out any device, and see sessions that ended in the last 30 days.
- Recent activity shows the last 30 days of sign-ins, failed sign-in attempts and security changes on the account, so a user can spot anything that was not them. No IP addresses are shown or stored in readable form.
- Users with a single passkey are prompted to add a second one (another device or a security key) so a lost device never locks them out.

### Authorization

- Every user-owned row carries `user_id`. Every router reads and writes through `app/security/authz.py` (`get_owned`, `owned_by`); a row that belongs to someone else answers 404.
- `services/api/tests/authz/` holds cross-user tests and grows with each router; every PR that touches the server runs it inside the full API suite (`ci.yml`), and `security.yml` runs it again on every change to main and weekly.
- Group members never see each other's amounts or emails; the server only ever holds % progress and each member's fixed-list "What helped" ids, shown to the group as totals only.

### Application

- Rate limits on code sends, sign-in attempts, invite-code joins, backup uploads and exports (`app/security/rate_limit.py`, counted in Postgres so every instance agrees): sign-in codes 5 per 15 minutes per IP and 5 per address, email-code checks (sign-in, email change, website deletion) 20 per 15 minutes per IP (October 24, 2026; each address still locks for 15 minutes after 5 wrong tries, and the attempt that locks it sends its owner the always-on "Several wrong codes were tried" email), sign-in attempts 10 per 15 minutes (a passkey sign-in's challenge, fetched on every visit to the sign-in screen for autofill, counts separately: 60 per 15 minutes, since October 22, 2026), invite-code joins 10 an hour, exports 5 a day per signed-in device (each export also sends the always-on alert email), backup uploads 60 an hour, starting a bank link 10 an hour, bank syncs 120 an hour, billing routes that call Stripe 30 per 15 minutes per signed-in device. Every security route whose success sends an always-on alert email counts 10 a day per signed-in device, each on its own (signed off October 28, 2026): adding a passkey, removing a passkey, signing out a device, approving a Link with your phone request, denying one (no email, but an audit row each; 10 a day per signed-in device, signed off October 28, 2026), replacing the backup key, turning backup off, the tester plan switch, finishing a bank link and disconnecting a bank (export keeps its 5 a day; plan changes and cancelling are under the Stripe limit; email-change codes under the code limits). Push: at most 10 live push registrations per person, web and native together; registering an 11th revokes the one registered longest ago (signed off October 28, 2026). Reviewed yearly.
- Response hardening on every API response: `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer`, frame denial, a deny-all CSP, and HSTS in production (`app/security/headers.py`).
- Receipt photos: JPEG and PNG have their metadata (EXIF, location, timestamps) stripped on the device; other images are re-encoded without it. Photos are never uploaded to our servers.
- Webhooks: every Stripe event's signature is verified before it is read; Plaid webhooks carry an ES256 signature checked against Plaid's published key, with a 5-minute age limit and a hash of the exact body, and only set flags (no data arrives that way). Since October 24, 2026: Stripe events are applied in the order Stripe created them, an older one delivered late is skipped and a subscription Stripe canceled is never reopened; a plan starts only once the payment is in; every refund is tagged at Stripe and looked up before paying, so a retry never pays twice; unknown Plaid key ids are not looked up again for 10 minutes and key lookups are capped at 10 a minute; reading a bank needs a plan that links.
- Bank and card linking is read-only (Plaid Transactions and Liabilities only; no account numbers, identity data or money movement) and runs on Plaid's hosted page, so no third-party script loads in the app.
- Readiness and errors never leak internals: one word per check, details to the log.

### Encryption

- **In transit:** TLS 1.2 or newer on every connection: the website and the app through CloudFront with HSTS (browsers never fall back to plain HTTP), the API, and the server's calls to Plaid, Stripe and email. The production database (being set up) is configured to require TLS from the API.
- **At rest:** object storage is encrypted with AES-256 (S3 server-side encryption), and the production database is encrypted at rest by the provider (Lightsail managed database encryption).
- **An extra application layer for the most sensitive values:** Plaid access tokens are encrypted again (Fernet: AES with an integrity check) under a dedicated key held only in the secret store, and decrypted only in memory inside the request that calls Plaid. Push-notification endpoints are also encrypted with Fernet, under a separate key derived from the server secret; session tokens are stored only as keyed hashes; IP addresses only as keyed hashes (pseudonyms).
- **End to end:** encrypted backups and a household's shared data are encrypted on the user's device with keys the server never sees, so the company cannot read them.
- **Data from Plaid** (transactions, balances, card statement details) is passed through to the user's device in memory and is not stored on the server.
- **Keys:** the link-token key is used for nothing else, is never logged or shown, is rotated at once if it may have been exposed (`incident-response.md`), and is kept so that losing it never happens silently: losing it would mean every user has to link their bank again.

### Infrastructure

- Hosting is AWS: Route 53 for DNS, CloudFront in front of private S3 buckets for the website and the app, a Lightsail container for the API, Lightsail PostgreSQL (private: no public access) and object storage (deployed October 13, 2026), SES for email (`docs/ops/aws-hosting.md`).
- TLS everywhere with AWS-managed certificates; HSTS; separate origins for the website (`qash.solutions`) and the app (`app.qash.solutions`) so the service worker and install scope are isolated.
- Encryption at rest for object storage (S3, AES-256) and for the database; buckets private with all public access blocked, reachable only through CloudFront.
- The app's Content-Security-Policy (scripts, styles, fonts and workers from its own origin only; no inline scripts, no `eval`; no third-party sources; framing refused) is set by the app's CloudFront distribution. The API sends a deny-all CSP on every response.
- The API container only answers requests that came through CloudFront (a secret `X-Origin-Verify` header added by CloudFront; production refuses to start without it), and reads the client's IP from CloudFront's own header, so rate limits cannot be dodged by a forged `X-Forwarded-For`.
- Outbound traffic from the API is limited to `tools/network_allowlist.txt`, statically in CI and at runtime through `app/security/outbound.py`.
- Administrative access: the AWS root user has multi-factor authentication and no access keys and is kept for emergencies; people administer AWS only through AWS IAM Identity Center (since October 16, 2026: one named user per person, a passkey or security key at every sign-in, the AdministratorAccess permission set with 4-hour sessions, and short-lived credentials for the command line through `aws sso login`). No person holds a long-lived AWS access key and no IAM user has a console password: the former admin IAM user's last access key and console password were removed on October 16, 2026. Two-factor sign-in is on for GitHub, the owner's Gmail, ImprovMX and Stripe (confirmed October 13, 2026). Least privilege for every identity: deploys run through `qash-deploy`, assumed by GitHub Actions over OIDC (no stored keys) and limited to the two site buckets, the two distributions and the one container service, and trusted only for jobs in the repository's `production` environment: the deploy workflow runs there after CI passes on a push to `main`, or when the owner starts it by hand; the API sends email through its own send-only user and reaches the backup bucket with that bucket's own access key (the two long-lived machine keys, kept only in the production secret store); production settings are a GitHub environment secret, never in the repository.
- Access reviews: at each yearly review, and whenever someone joins, leaves or changes role, the security owner lists every account and key with access to production (AWS Identity Center users and permission sets, IAM users and keys, GitHub, Stripe, Plaid, email), removes anything unused, confirms multi-factor sign-in on each, and records the review in `risk-assessment.md`. Access is granted by role: an Identity Center permission set for administration, purpose-built identities with only the permissions they need (for example, send-only email), and account-wide deny policies.
- An IAM policy (`qash-deny-bedrock`) denies every Amazon Bedrock call in the account, so no AI service can be used even by mistake (hard constraint 2).

### Supply chain and change management

- CI gates on every pull request: AI-package denylist (`tools/check_ai_denylist.py`), network allowlist, WCAG contrast, lint, type checks, golden tests for every money rule, migration-versus-model drift, and cross-user authorization tests. Since October 19, 2026 (GitHub Actions minutes are limited), each gate runs when the files it reads changed (`.github/scripts/changed.sh`); a scheduled weekly run, or a run that can't tell what changed, runs every gate.
- `security.yml`: pip-audit over the locked Python dependencies, `pnpm audit`, and gitleaks over the whole history; also weekly, so new advisories are caught without a code change.
- Lockfiles are committed; CI installs with `--frozen`; new install scripts need explicit approval (`pnpm approve-builds <pkg>`).
- Every change lands through a pull request that must pass every CI check before it is merged; nothing is pushed to `main` directly. A security-relevant change (`app/security/`, the denylist, the network allowlist, this folder) is approved by the security owner. GitHub enforces it: branch protection on `main` (October 13–16, 2026, and again since October 27, 2026, the repository being public; kept by process while it was private) requires pull requests, the checks `every CI check passed`, `every security check passed` and `guards (no AI packages · allowlisted hosts · contrast)` (each workflow's last job reads every other job's result, since GitHub counts a skipped job as passing), a branch up to date with `main`, no force pushes or deletion, and binds administrators. The access review still checks `main`'s history.
- Schema changes are hand-written migrations diffed against the models by a test; production migrations run as a release step, not at container start.

### Vulnerability and patch management

- **Detection:** every pull request that changes a manifest or lockfile, every change to the main branch that does, and a weekly scheduled run check the locked dependencies against known-vulnerability databases (pip-audit for Python, pnpm audit for JavaScript), the whole repository history for secrets (gitleaks), and run Trivy over the repository (vulnerabilities, secrets, Dockerfile and compose settings) and over the API container image built exactly as production builds it (operating-system packages and Python libraries); Trivy runs on every change to main and weekly, and on a pull request when its dependencies, Dockerfile or compose settings change. The secret scan runs on every pull request. A high or critical finding with a fix fails the check, so it cannot be merged past or missed.
- **Patch deadlines (SLA),** counted from when a scan or an advisory reports the issue:

| Severity | Fixed or mitigated within |
|---|---|
| Critical | 7 days; 48 hours if it is being actively exploited or touches sign-in, sessions or Plaid tokens |
| High | 30 days |
| Medium | 90 days |
| Low | the next scheduled update |

  A fix that cannot meet its deadline is recorded in `risk-assessment.md` with the reason, the mitigation in place and a new date.
- **Devices with production access:** every device used by anyone with access to production or customer data (the owner, staff or contractors) must have automatic operating-system and browser security updates on, the operating system's built-in malware protection, full-disk encryption and a screen lock. This is checked at every access review and before access is granted.
- **Customers' devices** belong to the customers; the company does not scan them. The app protects the data kept on them with passkeys, the user-chosen auto-lock and a strict Content-Security-Policy, and keeps no server copy of their transactions.
- **Production:** the API container is rebuilt from the patched base image at least monthly and whenever a critical advisory affects it, and every build is scanned by Trivy before it can ship.
- **End-of-life software:** the runtimes below are reviewed every quarter and at the yearly review against their published support dates; anything within six months of end of life gets a dated upgrade plan, and nothing past end of life runs in production.

| Component | Version | Supported until |
|---|---|---|
| Node.js (build and tooling) | 24 LTS | April 2028 |
| Python (API, rules) | 3.12 | October 2028 |
| PostgreSQL | 16 | November 2028 |
| API container base | `python:3.12-slim` (Debian) | follows Python 3.12 |
| Main frameworks | React 19, Vite 8, TypeScript 7, FastAPI, SQLAlchemy 2 | current major versions; updated with the dependency audits |

### Logging and monitoring

- `audit_log`: sign-ins (including failures), sign-outs, device links approved or denied from a phone, passkey changes, device revocations, exports, deletion requests, email changes, plan changes, auto-lock changes, bank connects, disconnects and automatic revokes. Actor, action, target identifier, pseudonymous IP (HMAC with a server-side key), time. No free text.
- Readiness failures go to the server log with no request data. Requests over a rate limit are refused (HTTP 429) and counted in Postgres.
- Administrative actions in AWS are recorded by the CloudTrail trail `qash-trail` (every region, log file validation, kept 13 months in a private bucket). Any root sign-in or root action, and any IAM change (users, access keys, policies, roles), emails the security owner within minutes (EventBridge → SNS `qash-alerts`).
- Cost alerts catch misuse such as a leaked key: a $50 monthly AWS budget (emails at $25 spent, $50 forecast, $50 spent) and Cost Anomaly Detection (any anomaly of $10 or more, at once).
- With the production API: alarms on the health check and on a spike in server errors, to the same email.
- Errors that need a person (October 25, 2026; `services/api/app/services/ops_alerts.py`): an unhandled API error, a failed scheduled job and a purge that skipped an account email the admins (`STACKD_ADMIN_EMAILS`) through SES, at most once per kind and place an hour. The email names the failure, the route template or job, the exception's type and the line in our code, and how often; never the exception's message, request data, amounts, emails or ids. The trace stays in the server log. No third-party error service is used. In the app, a screen that throws shows "Something went wrong" with Reload (`app/CrashScreen.tsx`); nothing about the error leaves the device.
- Retention: audit log 13 months, server logs 30 days. Scheduled jobs enforce both from the production API deployment (`docs/ops/aws-hosting.md`).

### Backups and resilience

- The production database (Lightsail PostgreSQL) is encrypted at rest with automatic daily backups. A restore is tested before launch and then every quarter; each test is recorded in `risk-assessment.md`.
- User backups are end-to-end encrypted on the device; a lost key means a lost backup, and the app says so at setup. Deleting an account purges its backups after the 30-day grace period stated in the privacy policy.
- Device storage can be cleared by the browser: the app asks for persistent storage, prompts Home Screen install, and reminds Free users to export.

### Privacy by design

- Collect only what a feature needs; no ad SDKs; no third-party analytics that share data.
- Account deletion in two taps in the app and on a public web page; full export on the device.
- Public wording about security matches what is built; no absolute claims.

## 5. Training and awareness

Every contributor reads `CLAUDE.md` "Hard constraints" and this plan before their first change. The security owner runs one tabletop incident exercise a year (`incident-response.md`) and re-reads this plan at each yearly review.

## 6. Testing and assurance

- Automated: every gate in section 4 runs on every pull request, including these checks:
  - `services/api/tests/security/test_route_guards.py`: every operation in the API's own OpenAPI document is tried without a session (401 unless on the short public list) and, for writes, from another origin (403 `cross_site`). The only exceptions are the website's account-deletion routes and the Stripe, Plaid, Apple and Google webhooks, each of which checks its own code or signature. A new route is covered the moment it exists.
  - `services/api/tests/authz/`: a cross-user case per router (security, groups, billing, backup, household, notifications, linking): another account's rows answer 404 or are simply absent.
  - `apps/web/tests/unit/leak-sweep.test.tsx`: distinctive amounts, merchants, a statement with an account number, a receipt, jars, a challenge, the backup, the household and the alert schedule run against the fake server; every request's URL and body is searched for them, and the only bodies allowed to carry anything derived from money data (the backup and household blobs) must be base64url ciphertext. `import-flow`, `receipts`, `groups`, `notifications` and `backup-ui` keep their narrower leak checks.
  - `apps/web/tests/unit/a11y.test.tsx` and `apps/site/tests/a11y.test.ts`: axe-core over every app screen and every website page (names, roles, labels, landmarks, headings, nested controls); colour contrast is the token guard's (`pnpm contrast`, 180 pairs, every look × mode).
  - `apps/web/tests/engine/golden.test.ts`: every golden case from `services/rules` through the device's engine door, so the on-screen numbers are the Python source of truth's.
- Before each push, on the owner's Mac (October 22, 2026; not in CI yet, to save Actions minutes): `pnpm -C apps/web e2e`, Playwright end-to-end journeys in the real browser against a real API and database of their own: sign-up with an emailed code and a passkey, the trial, a statement import, entries, categories, Don't count, ranges, budget, a jar, export, signing out and back in with the passkey, account deletion, swipe actions, Customize Home and the bills calendar, on a computer and a phone-sized screen. The first run found that opening the sign-in screen used up sign-in attempts (fixed: passkey challenges have their own limit).
- Before launch, still to do by people: an outside penetration test of the PWA, API and website (findings rated with `risk-assessment.md`, highs fixed first); a screen-reader pass on iOS VoiceOver and Android TalkBack; Lighthouse ≥ 90 on the deployed website; the legal review of the privacy policy and terms; the remaining owner decisions in the build spec (the Founding membership limit, the refund policy).
- Yearly: risk assessment refresh, vendor re-review, restore test record, tabletop exercise.

## 7. Safeguards Rule mapping (adopted whether or not the rule applies)

| Element | Where |
|---|---|
| Qualified individual | Section 2 |
| Written risk assessment | `risk-assessment.md` |
| Access control policy | `access-control-policy.md` |
| Data retention and disposal | `data-retention-policy.md` |
| Safeguards: access controls, data inventory, encryption, secure development, MFA, disposal, change management, monitoring | Sections 3 and 4 |
| Regular testing | Section 6 |
| Training | Section 5 |
| Service-provider oversight | `vendors.md` |
| Incident-response plan | `incident-response.md` |
| Periodic reporting to leadership | Yearly written summary by the security owner |

## 8. Approval and review log

| Version | Date | Change | Approved by |
|---|---|---|---|
| draft | 2026-10-10 | First draft with the build | n/a (draft) |
| 1.0 | 2026-10-13 | Adopted: security owner designated, bank and card linking (Plaid), AWS hosting, user-chosen auto-lock, the IAM block on AI services | Director, Qash Solutions Inc. |
| 1.1 | 2026-10-16 | AWS administration through IAM Identity Center (passkey at every sign-in, short-lived credentials, no personal access keys); both long-lived machine keys named; pull requests only kept by process once the repository went private; also records what was added on October 13 after adoption: the CloudTrail trail with root and IAM change alerts, and deploys through the OIDC role `qash-deploy` | Director, Qash Solutions Inc. |
| 1.2 | 2026-10-19 | Link with your phone: a signed-in phone, after a fresh passkey check, approves a computer's sign-in by code or QR code (2-minute requests, 3 an hour per IP, different-network warning, audit and alert); the phishing trade-off against the browser's Bluetooth-checked phone sign-in is recorded | Director, Qash Solutions Inc. (approved 2026-10-27) |
| 1.3 | 2026-10-27 | Branch protection on `main` enforced again (public repository): pull requests only, the three required gate checks, up to date with `main`, administrators included | Director, Qash Solutions Inc. (asked for 2026-10-27) |
| 1.4 | 2026-10-28 | Auto-lock counts only what the person does (background calls, cross-site requests and page loads never extend it; the screen lock locks the server session until the next passkey check); each Link with your phone request is answered once; at most 10 live push registrations per person; denying a link request 10 a day per device | Director, Qash Solutions Inc. (owner decisions 2026-10-28) |
