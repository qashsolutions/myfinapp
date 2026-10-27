# Security: owner, reporting, scope

*Version 1.0, effective October 13, 2026, approved by the Director of Qash Solutions Inc. The public wording gets a one-time legal review before launch.*

## Owner

**Security owner: the Director of Qash Solutions Inc.** (security@qash.solutions). The owner's name and signature are on the signed copy of this program held by the company and given to partners on request; this public repository names the role only. One named person is responsible for security (docs/spec.md "Security program"): this document set, the yearly risk assessment, the incident-response plan, vendor reviews, and the pre-launch penetration test. The owner approves every change to `tools/denylist.txt`, `tools/network_allowlist.txt`, `app/security/`, and this folder.

Deputy (acts when the owner is unavailable): none yet; the security owner covers the role until one is appointed.

## Reporting a vulnerability

- Email **security@qash.solutions**. If the report contains exploit details or user data, say so in a first message and we will arrange a secure channel.
- We acknowledge within **2 business days**, give an initial assessment within **7 days**, and keep the reporter informed until the fix ships. We credit reporters who want credit.
- Good-faith research is welcome and will not be reported to law enforcement: stay within the scope below, use your own accounts, do not access or modify other people's data, do not degrade the service, and give us reasonable time to fix before disclosure.

## Scope

In scope: the app at `app.qash.solutions`, the API behind it, the website at `qash.solutions`, and this repository.

Out of scope: volumetric denial of service, social engineering of staff or users, physical attacks, and findings in third-party providers' own systems (report those to the provider; tell us too if our configuration is the cause).

## What we hold, and what we never hold

The app is local-first. Statements, receipt photos and transactions live only on the user's device. The server holds the account (email, display name, passkeys), the plan, group **% progress**, a minimal alert schedule (date, type, generic label) and, for paid plans, an end-to-end encrypted backup it cannot decrypt. On the Connected plan it also holds, per linked bank or card, a read-only Plaid access token encrypted under a dedicated key, the institution name and the connection's status; linked transactions and card details pass through to the device and are not stored. There are no bank passwords, account numbers or card numbers anywhere, nothing can move money, and no AI or LLM service is called at runtime (`tools/check_ai_denylist.py` enforces this in CI; an IAM policy blocks AI services in the AWS account).

## Documents in this folder

| File | What | Review |
|---|---|---|
| `security-plan.md` | Written information security plan: controls, who does what, how changes are gated | Yearly, and on any architecture change |
| `access-control-policy.md` | Who may access production and sensitive data; granting, removing and reviewing access; authentication, secrets, devices | Yearly, and when people or systems change |
| `data-retention-policy.md` | Consent, the retention schedule for every kind of data, account deletion, disposal methods, consumer requests | Yearly, and when what we collect changes |
| `risk-assessment.md` | Risks, likelihood and impact, controls, residual risk | Yearly (next: October 2027) and after any incident |
| `incident-response.md` | Roles, severity levels, steps, breach-notification duties | Yearly, plus one tabletop exercise |
| `vendors.md` | Hosting, email, push, payments, bank-data providers: what each sees, review status | On onboarding and yearly |
| `linking.md` | Bank and card linking through Plaid: products, token handling, what is stored, disconnect and dormancy | With any linking change, and yearly |

## Supported versions

Only the current deployment is supported; there are no long-lived versions to patch separately.
