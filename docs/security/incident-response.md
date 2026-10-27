# Incident response

*Version 1.1, effective October 16, 2026 (first adopted October 13, 2026). Owner: the Director of Qash Solutions Inc. The notification duties in section 6 get a one-time legal review before launch; one tabletop exercise a year.*

## 1. Roles

| Role | Who | Backup |
|---|---|---|
| Incident commander: decides, keeps the timeline, owns communication | Director, Qash Solutions Inc. | none yet |
| Engineering: investigates, contains, fixes | The Director, with engineering help as engaged | |
| Legal: notification duties, regulator contact, wording | the Director, with an outside legal review when an incident needs one | |
| Communications: user and public messages | The Director | |

Reports arrive at security@qash.solutions. Phone numbers and provider support contacts are kept by the security owner outside this repository.

## 2. What counts as an incident

Anything that may have exposed, altered or destroyed user data, let someone act as another user, or taken the service down: a cross-user access bug, a leaked secret, a compromised account or device, a vendor breach that touches our data, a malicious dependency, or sustained abuse.

## 3. Severity

| Level | Meaning | First response |
|---|---|---|
| S1 | Confirmed exposure or alteration of user data, or active attacker access | Immediately, around the clock |
| S2 | Likely exposure not yet confirmed; service-wide outage; leaked secret | Within 1 hour |
| S3 | Single-account compromise; vulnerability reported with no sign of exploitation | Same business day |
| S4 | Abuse or probing with no data impact | Next business day |

## 4. Steps

1. **Detect and declare.** Anyone who suspects an incident tells the incident commander, who declares it, sets a severity, and opens a private timeline (time, who, what, evidence).
2. **Contain.** Stop the bleeding before understanding everything:
   - Revoke the affected sessions (`sessions.revoked_at`) and force re-authentication; tell the affected users with the always-on security alert.
   - Rotate any secret that may be exposed: database and storage credentials, `STACKD_SECRET_KEY`, `STACKD_IP_HASH_KEY`, VAPID keys, Stripe keys and webhook secret, the Plaid client secret, `STACKD_LINK_TOKEN_KEY`, email credentials. Redeploy.
   - If Plaid access tokens may be exposed, revoke the affected connections at Plaid (`/item/remove`, the same path as Disconnect); users link again on their next visit.
   - Disable the affected route or feature with a deploy if that is faster than a fix.
   - Preserve evidence: export the relevant `audit_log` rows and server logs before anything rotates them.
3. **Investigate.** Establish what happened, when, to whom, and through what. Sources: `audit_log` (actor, action, target, pseudonymous IP, time), server logs, AWS logs (the CloudTrail trail `qash-trail` and its bucket, the Lightsail container logs), the Stripe and Plaid dashboards, email-provider logs, git history and CI logs.
4. **Eradicate and recover.** Fix the cause, add a test that would have caught it, deploy, verify, and restore from backup if data was altered (restores are tested before launch and then quarterly; see `risk-assessment.md`).
5. **Notify** (section 6).
6. **Review.** Within 10 days: a written post-incident review with the timeline, root cause, what worked, what did not, and dated actions. Update `risk-assessment.md`.

## 5. Playbooks

- **Cross-user data access bug.** S1 if exploited, S2 otherwise. Disable the route, fix, add the case to `tests/authz`, identify affected users from `audit_log` and server logs, notify them.
- **Leaked secret.** S2. Rotate first, then find where it was used (`audit_log`, provider logs), then remove from history and run gitleaks again.
- **Compromised user account.** S3. Revoke sessions and passkeys at the user's request after identity verification, re-enrol, review their `audit_log`.
- **Vendor breach.** Severity by what the vendor held (`vendors.md`). Get the vendor's statement in writing; assess our data; notify as in section 6.
- **Plaid token or key exposure.** S1. Rotate `STACKD_LINK_TOKEN_KEY` and the Plaid secret; revoke every connection that may be affected at Plaid; tell Plaid; notify the users whose connections were revoked and explain how to link again. Linked transactions are never stored on the server, so the exposure is the ability to read, not stored history.
- **Malicious or vulnerable dependency.** S2. Pin or remove, rebuild, deploy, check `audit_log` and outbound logs for the exposure window.

## 6. Notification

- **Users.** Affected users are told plainly and promptly what happened, what data was involved, what we did, and what they should do. Security alerts go by email and cannot be disabled by the user.
- **Regulators and state attorneys general.** Breach-notification duties depend on the state of residence of each affected user; timelines run from discovery and are commonly 30 to 60 days, some shorter. The security owner confirms which laws apply (with an outside legal review when needed) and prepares the notices. If the FTC Safeguards Rule applies, the FTC must be notified within 30 days of discovering a breach affecting 500 or more consumers.
- **Payment data.** Stripe holds all card data; if Stripe reports a breach, follow their instructions and notify affected users.
- **Bank data partner.** Tell Plaid promptly about any incident that touches Plaid tokens or linked data, as Plaid's terms require.
- **Providers.** Tell the hosting, email, push or payment provider when the incident touches their systems or credentials.

Public statements never claim more than is known.

## 7. Exercises

One tabletop exercise a year, run by the security owner, using one of the playbooks above; the date, the scenario and the lessons are recorded here. No exercise yet: the first one runs before launch, using the Plaid token or key exposure playbook.
