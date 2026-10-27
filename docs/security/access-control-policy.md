# Access control policy

*Version 1.1, effective October 16, 2026 (first adopted October 13, 2026). Owner and approver: the Director of Qash Solutions Inc. Reviewed yearly (next: October 2027) and whenever people, systems or vendors change. Part of the information security program (`security-plan.md`); where they differ, the security plan applies.*

## 1. Purpose and scope

This policy sets who may access Qash's production systems and sensitive data, how that access is granted, protected, reviewed and removed. It covers every system that stores or processes user data or controls production: the AWS account (hosting, database, storage, email sending, DNS), the source code repository and its CI, the Stripe and Plaid dashboards, the company email accounts, and the devices used to administer them. It applies to everyone with access, including the owner, future staff and contractors.

## 2. Principles

1. **Least privilege.** Every person and every system gets only the access its job needs, and nothing by default.
2. **Need to know.** Sensitive data is accessed only to operate or secure the service, never out of curiosity and never for analytics or advertising.
3. **Strong authentication everywhere.** Every human account with access to production uses multi-factor authentication.
4. **No standing shortcuts.** Production data is reached through the application, not by connecting to databases or storage directly.
5. **Every grant is recorded and reviewed,** and removed when no longer needed.

## 3. Roles

| Role | Who | Access |
|---|---|---|
| Administrator (security owner) | The Director of Qash Solutions Inc. | Administers AWS, GitHub, Stripe, Plaid and email; approves every access grant and every security-relevant change |
| Tester (in the app) | The administrator's own Qash account, named by email in the production secret `STACKD_ADMIN_EMAILS` (never in the repository) | Switches that account's own plan for free and skips the 30-day downgrade wait, to test every plan; each switch needs a passkey check, is audited and sends the always-on plan-change email. No access to any other account or to customer data |
| Contributor (future staff or contractors) | Named individuals approved by the administrator | Source code through pull requests only; no production or customer-data access unless granted in writing for a stated task and period |
| Service identities | The API, the jobs container, the email sender | Machine credentials limited to the resources that service uses |
| End users | Qash customers | Their own account and data only |

Today the administrator is the only person with access to production.

## 4. Granting, changing and removing access

- **Granting.** Access is requested for a stated purpose, approved by the administrator, granted at the lowest level that works, and recorded (who, what, why, when).
- **Changing.** When someone's role changes, access the new role does not need is removed the same day.
- **Removing.** When someone leaves or a contract ends, every account, key and token they held is disabled within 24 hours, and shared secrets they could have seen are rotated. AWS access for people is managed centrally in AWS IAM Identity Center: disabling or deleting the person's Identity Center user ends all of their AWS access at once, including sessions already open within at most their 4-hour session length. GitHub, Stripe, Plaid and the email accounts are separate logins, each with multi-factor authentication, and are removed one by one from the list of accounts reviewed under section 11.
- **Unused access.** Accounts, keys and tokens that are not in use are deleted, not just disabled.

## 5. Authentication

- **Multi-factor authentication** is required on every human account with access to production or customer data: the AWS root user, AWS IAM Identity Center users, GitHub, Stripe, Plaid, and the company email and forwarding accounts.
- **People sign in to AWS only through AWS IAM Identity Center** (since October 16, 2026): a named user per person, a phishing-resistant passkey or security key at every sign-in, and access through a permission set whose sessions last at most 4 hours. Command-line access uses the same sign-in and receives short-lived credentials; no person holds a long-lived AWS access key, and no IAM user has a console password.
- **AWS root** has multi-factor authentication and no access keys, and is kept for emergencies and the few tasks that require it.
- **No shared accounts.** Each person signs in as themselves.
- **End users** sign up with an email code and a passkey (no passwords); afterwards they sign in with the passkey (with Face ID, Touch ID, fingerprint or the device passcode), or with the email code and then the passkey on a device that does not have it, or, on a computer, by approval from their phone where they are already signed in ("Link with your phone", October 19, 2026): the phone passes a fresh passkey check before Approve, sees the requesting browser and system, is warned and must confirm when the computer is on a different network, requests expire after 2 minutes and are limited to 3 an hour per network address, and every approval is audited and sends an always-on email. Approval by phone is not phishing-resistant the way a passkey is (it does not prove the phone is near the computer), so the computer is offered its own passkey right after. The app locks after an inactivity period the user chooses (5 to 60 minutes) and asks for the passkey again before sensitive actions: export, account deletion, email change, plan change, bank linking, removing a passkey or device, and changing the auto-lock. Users see their signed-in devices with status, can sign any of them out, and see 30 days of sign-ins, failed attempts and security changes.

## 6. Privileged and production access

- **AWS permissions are granted by role:** people receive an Identity Center permission set (today one, AdministratorAccess, held by the administrator), and systems use purpose-built identities with only the permissions they need (for example, an email identity that can only send from the company domain), and account-wide deny policies (no AI or ML services).
- **The production database and API** are reachable only through the application, never from the public internet. Website and app files are in private storage with all public access blocked, served only through CloudFront over TLS.
- **Code reaches production only through pull requests** that pass automated security checks. This is our own rule, followed for every change: no one pushes to the main branch directly, and a pull request is merged only after every check has passed. GitHub does not enforce it on our plan, so the rule is checked at each access review against the main branch's history.

## 7. Service identities and secrets

- Each service has its own credentials with only the permissions it needs. Deploys use short-lived credentials from GitHub's OIDC sign-in (no stored keys). Two long-lived machine keys exist, both used only by the API and kept only in the production secret store: the email sender, which can only send from `no-reply@qash.solutions`, and the access key for the backup storage bucket, which reaches that one bucket only. Both are listed at every access review.
- **Secrets** (encryption keys, API keys, the Plaid client secret, Stripe keys) live only in the hosting provider's secret store. They are never in source code, chat, tickets or logs; an automated secret scanner checks the full repository history on every change.
- **Plaid access tokens** are encrypted at rest with a dedicated key, decrypted only in memory inside the request that calls Plaid, never shown to any person, never logged and never sent to a user's device. They are revoked at Plaid when a user disconnects, deletes their account, or has not used the connection for 60 days.
- A secret that may have been exposed is rotated at once (`incident-response.md`).

## 8. Encryption

All data is encrypted in transit (TLS 1.2 or newer, HSTS) and at rest (AES-256 storage and database encryption). Plaid access tokens carry an additional application-level encryption layer under a dedicated key, decrypted only in memory when calling Plaid. Backups and household data are encrypted end to end on the user's device. Details: `security-plan.md`, "Encryption".

## 9. Access to customer data

- **Users reach only their own data.** Every request is checked against the signed-in account; another account's data answers "not found". Automated tests try every API route without a session and across accounts on every change.
- **What the server holds is minimal by design:** account details, plan, challenge percentages, a minimal alert schedule, encrypted backups the company cannot open, and encrypted Plaid tokens. Transactions, statements, receipts and card details stay on the user's device; linked bank data passes through the server and is not stored.
- **Staff do not browse customer data.** Investigating a specific problem uses the audit log and the minimum data needed, and the access is recorded.

## 10. Devices

Every device used by anyone with access to production or customer data (the owner, staff or contractors) must have full-disk encryption, a screen lock, automatic operating-system and browser security updates, and the operating system's built-in malware protection, and is never shared. This is checked before access is granted and at every access review. Customers' own devices are theirs and are not scanned; the app protects the data on them with passkeys, the auto-lock and a strict Content-Security-Policy.

## 11. Logging and review

- **Security-relevant actions are recorded** in an audit log with no financial data: sign-ins and failures, passkey and device changes, exports, deletion requests, email, plan and auto-lock changes, bank connections. AWS administrative actions are recorded by CloudTrail.
- **Access reviews** happen yearly and whenever someone joins, leaves or changes role: every account and key with access to production is listed, anything unused is removed, multi-factor authentication is confirmed, and the review is recorded in `risk-assessment.md`. The first review took place on October 13, 2026.

## 12. Exceptions and enforcement

An exception needs the administrator's written approval with a reason and an end date, and is recorded in `risk-assessment.md`. Breaking this policy leads to access being removed and, for staff or contractors, to the action their agreement provides.

## 13. Approval

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1.0 | 2026-10-13 | Adopted | Director, Qash Solutions Inc. |
| 1.2 | 2026-10-18 | The in-app Tester role (tester tools for the administrator's own account) | Director, Qash Solutions Inc. |
| 1.1 | 2026-10-16 | AWS access for people moved to AWS IAM Identity Center (passkey at every sign-in, short-lived credentials); the admin IAM user's access key and console password removed; pull requests only and every check before merge kept by process once the repository went private; both long-lived machine keys named | Director, Qash Solutions Inc. |
| 1.3 | 2026-10-19 | End users may sign a computer in by approval from their signed-in phone after a fresh passkey check; the phishing trade-off and its safeguards are stated | Director, Qash Solutions Inc. (pending) |
