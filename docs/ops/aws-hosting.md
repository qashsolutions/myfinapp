# Hosting on AWS

*Draft, October 12, 2026, for owner approval. Owner decision, October 12, 2026: everything runs on AWS (account "Qash Solutions Inc"), region `us-east-1`. Vercel is not used for this product.*

Nothing here is created until the owner approves its step. Each step lists who does it: **owner** (account security, billing, secrets, anything Claude must not type) or **Claude** (through the console in Chrome, or code in this repo by PR).

## What runs where

```
qash.solutions, www ──► CloudFront "site" ──► S3 qash-site (private, OAC)        apps/site build
app.qash.solutions  ──► CloudFront "app"  ──► S3 qash-app  (private, OAC)        apps/web build
                                     └─ /api/* ──► Lightsail container "qash-api" services/api image
                                                     ├─ api   (uvicorn :8000)
                                                     └─ jobs  (dispatch-alerts, purges, recap on a loop)
                                                     ├──► Lightsail PostgreSQL 16 "qash-db" (private)
                                                     ├──► Lightsail bucket "qash-backups" (ciphertext only)
                                                     └──► SES (SMTP, email-smtp.us-east-1.amazonaws.com:587)
DNS: Route 53 zone qash.solutions (Z095710719TZRUIM7EES4)   TLS: one ACM certificate in us-east-1
```

- **`/api` is same-origin.** The app distribution sends `/api/*` to the container with caching off and every header, cookie and query string forwarded, so the session cookie, `same_site_only` and WebAuthn (`rp_id` `app.qash.solutions`) work with no CORS. Everything else is the PWA from S3.
- **The container only answers CloudFront.** CloudFront adds a secret header (`X-Origin-Verify`); the API refuses any request without it (new middleware, below). With that, `STACKD_TRUST_PROXY_HEADERS=true` is safe: the client IP comes from CloudFront's `X-Forwarded-For`.
- **SPA fallback without error pages.** A CloudFront Function on the app's default behaviour rewrites paths with no file extension to `/index.html`. (Custom error responses would also swallow the API's real 404s.) The site gets a function that maps `/pricing` to `/pricing.html` and redirects `www` to the apex.
- **Headers.** One CloudFront response-headers policy per distribution: HSTS, nosniff, `Referrer-Policy`, `X-Frame-Options: DENY`; `sw.js` and `index.html` uncached, `/assets/*` immutable.

## Monthly cost (approximate, list prices)

| Piece | Choice | ~$/month |
|---|---|---|
| Static site + PWA | S3 + CloudFront (always-free tier: 1 TB, 10M requests) | 0–2 |
| DNS | Route 53 zone + queries | 1 |
| API | Lightsail container service, Micro (0.25 vCPU, 1 GB), 1 node, HTTPS included | 10 |
| Database | Lightsail managed PostgreSQL, Standard (1 GB RAM, 40 GB SSD) | 15 |
| Backups bucket | Lightsail object storage, 5 GB plan | 1 |
| Email | SES, $0.10 per 1,000 | <1 |
| Secrets | Container environment set by the deploy workflow from GitHub secrets | 0 |
| **Total** | | **~27–30** |

Later, not now: the High-availability database plan (~$30), a second container node (~$10).

## Steps

### A. Account safety (owner, first)
1. **Done October 16, 2026.** Root has MFA and no access keys. AWS Organizations (this account as management account) and IAM Identity Center (single-Region instance in us-east-1; the portal address and user names are kept out of the repository): one user for the owner (email `admin@`), MFA at every sign-in with security keys or built-in authenticators only, permission set AdministratorAccess (4-hour sessions) assigned on this account. The Mac's AWS CLI signs in with `aws sso login` (profile `default` and `qash`, sso-session `qash`). The old admin IAM user has no access key and no console password. AWS's own Identity Center emails did not arrive (nothing reached ImprovMX), so the first password was a one-time password shown in the console. Claude does not change account security settings without the owner's OK.
2. **Done October 13, 2026: cost and security alerts**, all emailing `admin@qash.solutions` (forwarded to the owner), under $1 a month in total.
   - SNS topic `qash-alerts` (us-east-1) with an email subscription to `admin@qash.solutions`; the topic policy lets EventBridge, CloudWatch, Budgets and Cost Anomaly Detection publish from this account.
   - AWS Budgets `qash-monthly`: $50 a month (expected spend ~$25–35); emails at actual > $25, forecast > $50, actual > $50. The account's older `My Zero-Spend Budget` ($1) stays.
   - Cost Anomaly Detection: subscription `qash-anomalies` on the default services monitor, sent at once through `qash-alerts` for any anomaly of $10 or more. The default subscription (daily, $100 and 40%) is left as it was.
   - CloudTrail `qash-trail`: every region, global service events, log file validation, into the private bucket `qash-cloudtrail-236823123138` (public access blocked, encrypted, TLS only, objects expire after 395 days = 13 months). Management events only, so the first trail is free; S3 storage is cents.
   - EventBridge rules (us-east-1) → `qash-alerts`: `qash-root-activity` (any root sign-in or root action) and `qash-iam-changes` (any IAM write: users, access keys, policies, roles). The email names the action, who, when and from which IP.
   - **Done October 13, 2026, with the API:** Route 53 health check `qash-api` (HTTPS `app.qash.solutions/api/auth/session` every 30 s, so it exercises CloudFront, the origin header and the container) with the CloudWatch alarm `qash-api-down` (3 failed minutes; emails on failure and on recovery), and `qash-app-5xx` (the app distribution's 5xx rate above 5% in 3 of 5 minutes). About $0.70 a month together.
3. No AI services (owner decision, October 12, 2026; spec hard constraint 2). The customer-managed policy `qash-deny-bedrock` (deny `bedrock:*`, `bedrock-runtime:*`, `bedrock-agent:*`, `bedrock-agent-runtime:*`) is attached to the `denali_admin` group, so no IAM login can call a model even by mistake; attach it to every new role too (the deploy role in G, the Lightsail container's credentials). The three Anthropic-on-Bedrock Marketplace subscriptions from February and May 2026 (about $6 of use, none since June) stay listed because AWS gives buyers no cancel for Bedrock model offers; they cost nothing unless a model is called, which the policy refuses. The root user is outside IAM policies: never use root for daily work.

### B. Certificate and DNS (Claude, owner approves each record)
3. ACM (us-east-1): one public certificate for `qash.solutions`, `www.qash.solutions`, `app.qash.solutions`, DNS validation; the validation CNAMEs go into the zone.
4. After C and D: alias A/AAAA records for `qash.solutions` and `www` → the site distribution, `app` → the app distribution.
   (Auto mode blocks DNS edits by Claude; the owner approves them or enters the values Claude gives.)

### C. Static hosting (Claude)
5. S3 buckets `qash-site` and `qash-app`: private, Block Public Access on, versioning on, SSE-S3.
6. **Done October 13, 2026** (app: distribution `E3B3M9OV4HUBRW`, `d1qkq8ufvm9fpb.cloudfront.net`; function `qash-app-request` sends extension-less paths to `index.html` on the default behaviour only, so API errors are never rewritten; response headers policy `qash-app-headers` with the CSP below plus `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()`; `/api/*` → origin `lightsail-qash-api` over HTTPS with `X-Origin-Verify`, caching disabled, origin request policy `qash-api-forward` (cookies, query strings and only the headers the API reads: Origin, Sec-Fetch-Site, User-Agent, Content-Type, Accept, Stripe-Signature, Plaid-Verification, CloudFront-Viewer-Address; never Host); bucket policy lets only this distribution read `qash-app`; A/AAAA alias `app.qash.solutions`). Two CloudFront distributions with Origin Access Control, the certificate, HTTP/2+3, TLS 1.2+, the functions and header policies above, price class "North America and Europe". The app's header policy adds a strict Content-Security-Policy (default-src 'self'; scripts, styles, fonts and workers from the app's own origin; `wasm-unsafe-eval` for the on-device OCR; connect-src 'self'; frame-ancestors 'none'), tested against a production build before it goes live (security plan, "Infrastructure"; risk 17). The live policy: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`. The pre-paint theme script moved to `public/theme-init.js` so no inline script is needed; checked on October 13, 2026 against the production build: no violations, workers and the OCR wasm load, `eval` is refused.
7. The website hides every link to the app until `PUBLIC_APP_LIVE=true` at build time (owner decision, October 13, 2026: the app is deployed for testing before it opens). First upload by hand from a local build (`pnpm turbo run build --filter=@stackd/site --filter=@stackd/web`), then the deploy workflow (G) takes over.

### D. API, database, storage (Claude, owner enters secrets)
8. **Done October 13, 2026.** Lightsail PostgreSQL 16 `qash-db` (`micro_2_0`, 1 GB, 40 GB, encrypted, us-east-1a), database and user `stackd`, public mode **off**, automatic backups on (7 days). The master password was generated by Lightsail and went straight into the production settings; nobody typed or saw it.
9. **Done October 13, 2026.** Lightsail bucket `qash-backups` (5 GB plan, object versioning off), private, with one access key for the API (S3-compatible: `STACKD_S3_ENDPOINT_URL`, `STACKD_S3_BUCKET`, `STACKD_S3_ACCESS_KEY` / `_SECRET_KEY`).
10. **Done October 13, 2026** (`https://qash-api.s5pawm50kv642.us-east-1.cs.amazonlightsail.com`, reachable only with the origin header). Lightsail container service `qash-api`, Micro × 1, with two containers from the same image: `api` (public endpoint, health check `/health/ready`) and `jobs`. The image runs `stackd-api migrate` before uvicorn.
11. Settings: `STACKD_ENV=prod`, `STACKD_RP_ID=app.qash.solutions`, `STACKD_ORIGINS=["https://app.qash.solutions"]`, `STACKD_SITE_ORIGIN=https://qash.solutions`, `STACKD_COOKIE_SECURE=true`, `STACKD_EMAIL_BACKEND=smtp`, the SMTP and S3 values, and fresh `STACKD_SECRET_KEY`, `STACKD_IP_HASH_KEY`, `STACKD_ORIGIN_VERIFY`. **Secrets (October 13, 2026):** generated on the operator's machine (random keys, the Lightsail database password, the bucket key, the SES SMTP password derived from the send-only user's key) straight into a private file and from there into the GitHub environment secret `STACKD_PROD_ENV_JSON` (environment `production`; the deploy workflow runs there on its own only after CI passes on `main`, or when the owner starts it by hand); never printed, never in chat or git; the local file is deleted afterwards. To rotate one, change it in that secret and run the deploy workflow. Stripe, Plaid, VAPID, APNs and FCM stay unset (those features stay off) until each is ready. **Stripe (October 26, 2026):** the live restricted key, the live webhook secret and the five live price IDs are in the secret; sales stay shut until `STACKD_BILLING_OPEN` is added (`admins` for the live test with the owner's card, then `everyone` at launch). Unset means `off` in production.

### E. Email (SES)
12. **Done October 13, 2026.** Domain identity `qash.solutions` verified in SES us-east-1 with Easy DKIM (three `_domainkey` CNAMEs), custom MAIL FROM `mail.qash.solutions` (MX `feedback-smtp.us-east-1.amazonses.com` + SPF TXT), and DMARC `_dmarc` TXT `v=DMARC1; p=quarantine; adkim=r; aspf=r` (monitor only until October 27, 2026, then `quarantine` once SPF, DKIM and DMARC were seen passing on real mail; spoofed mail now goes to spam). A test send to the SES simulator succeeded.
13. **Already done:** the account has SES production access (granted earlier; 50,000 a day, 14 a second).
14. **Receiving (owner decision, October 13, 2026): ImprovMX forwarding**, free, MX `mx1`/`mx2.improvmx.com` and apex SPF `include:spf.improvmx.com` in Route 53; `admin@`, `support@`, `security@`, `privacy@` forward to the owner's inbox (the owner adds the domain and aliases in ImprovMX). Replies go out through SES: IAM user `qash-ses-smtp` (inline policy: `ses:SendRawEmail` on the `qash.solutions` identity, From `*@qash.solutions` only) holds the SMTP login for Gmail's "Send mail as"; its credentials were handed to the owner in a private file, never in chat or git. Rotate by deleting its access key and creating a new one.
15. **Done October 13, 2026:** IAM user `qash-api-ses` (inline policy: `ses:SendRawEmail` / `ses:SendEmail` on the `qash.solutions` identity with From `no-reply@qash.solutions` only; `qash-deny-bedrock` attached). SMTP settings for the app (`STACKD_EMAIL_BACKEND=smtp`, from `no-reply@qash.solutions`), using a separate send-only IAM user for the container.

### F. Code changes (Claude, by PR)
15. **Done.** `security/origin_verify.py`: requests without `X-Origin-Verify` = `STACKD_ORIGIN_VERIFY` get 403 (`/health` and `/health/ready` stay open for the Lightsail health check); production refuses to start without it and without `STACKD_TRUST_PROXY_HEADERS=true`. `client_ip` reads `CloudFront-Viewer-Address` (CloudFront sets it, the client cannot), so the `/api/*` behaviour's origin request policy must forward that header; X-Forwarded-For's first entry is only a fallback. Tests in `tests/security/test_origin_verify.py`.
16. **Done.** Dockerfile: the default command migrates then serves; `stackd-api jobs-loop` (dispatch-alerts every minute; plan-lifecycle and settle-deletions hourly; purge-deleted, purge-backups, revoke-links, purge-audit and purge-expired daily) for the `jobs` container. Create the backup bucket without object versioning, so deleted backups are gone (data retention policy, section 6). Set the containers' log retention to 30 days (security plan, "Logging and monitoring").
17. `docs/security/vendors.md`: AWS rows for hosting, PostgreSQL, object storage and SES; `SECURITY.md` hosting line.

### G. Deploys (Claude writes, owner creates the role)
18. **Done October 13, 2026:** the GitHub OIDC provider and role `qash-deploy` (trusted only for `repo:qashsolutions/myfinapp:environment:production`; S3 objects in `qash-site` / `qash-app`, invalidations on the two distributions, image push and deployments on `qash-api` only; `qash-deny-bedrock` attached). Originally: an IAM role for GitHub Actions through OIDC (no long-lived keys), limited to the two buckets, the two invalidations and the one Lightsail service. Claude supplies the exact policy.
19. **Done.** `.github/workflows/deploy.yml` runs after `ci` succeeds for a push to this repository's `main` (never for a fork's pull request), or by hand: build, `aws s3 sync` with cache headers, CloudFront invalidation of `index.html` and `sw.js`; build the API image, `aws lightsail push-container-image`, new deployment, wait for healthy.

### H. Go-live checks (Claude)

First deployment October 13, 2026 (deploy run 2 is live). Checked from outside: the API answers through `app.qash.solutions` (database, migrations, storage ok); the container's own address refuses everything but the health checks (403 without or with a guessed `X-Origin-Verify`); cross-site writes 403; API docs hidden; the app's CSP, HSTS, frame and permissions headers present; the public deletion route answers `https://qash.solutions` and refuses other origins; the website has no app links; the jobs container runs every job; no secret value appears in the deploy log. Still to do with the owner: a real sign-up (email code through SES, passkey), lock and unlock, export, and deletion on the live app.

20. `https://qash.solutions` and every site page load over TLS; `www` redirects; `https://app.qash.solutions` loads, works offline after the first visit, and installs.
21. `/api/health/ready` through CloudFront is ok; the container's own URL answers 403 without the header.
22. Sign-up end to end: email code (SES), passkey, lock, step-up.
23. `security.txt`, privacy and terms reachable: what Plaid's reviewers need.

## Order

A → B.3 → C → D → F → E → G → B.4 → H. The website alone can go live after A, B, C and the site half of B.4, which is all Plaid needs; the app follows once D–F work.

## Not in this plan

The user-facing rename (`[Name]`, `[domain]`, `[Company legal name]`, the app id) is its own branch, after the site resolves. Staging environment, WAF and multi-AZ come after launch.
