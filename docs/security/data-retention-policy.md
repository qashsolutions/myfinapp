# Data retention and disposal policy

*Version 1.7, effective October 28, 2026 (first adopted October 13, 2026). Owner and approver: the Director of Qash Solutions Inc. Reviewed at least yearly (next: October 2027) and whenever what we collect or where we keep it changes. Part of the information security program (`security-plan.md`). The public version is the privacy policy at https://qash.solutions/privacy ("Your consent", "How long we keep it", "Deleting your account"); where they differ, the privacy policy applies to consumers.*

## 1. Purpose and scope

This policy sets how long Qash Solutions Inc. keeps each kind of data, how it is deleted, and how consumers' consent and deletion requests are handled. It covers every place data lives: our servers and storage on AWS, our service providers, and the app's storage on consumers' own devices.

## 2. Principles

1. **Collect as little as possible.** Financial data (transactions, statements, receipts, budgets, goals) is kept on the consumer's own device, not on our servers. Data received from Plaid passes through our servers to the device and is not stored.
2. **Keep it only as long as it is needed,** for the period in the schedule below, then delete it.
3. **Deletion is automatic.** Scheduled jobs carry out the schedule; nothing depends on someone remembering.
4. **Deletion is final.** Deleted records are removed from the database and storage, not hidden.
5. **Consent first.** Optional processing happens only after the consumer opts in, and stops when they withdraw.

## 3. Consent

- **Account:** consumers agree to the Terms and the privacy policy before they create an account.
- **Separate, explicit opt-in** for each optional kind of processing:
  - **Bank and card linking:** the consumer starts it, confirms with a passkey, and agrees in Plaid's own consent screen, choosing each account to share.
  - **Push notifications:** the device asks the consumer's permission.
  - **Encrypted backup and household sharing:** off until the consumer turns them on.
- **Withdrawal** at any time, in the app: disconnecting a bank or card revokes its access at Plaid at once (if Plaid cannot be reached, the connection is hidden from the consumer immediately and the revoke is retried daily until it succeeds); notifications, backup and household sharing switch off; and the account can be deleted. Withdrawing one consent never affects the rest of the account.

## 4. Retention schedule

| Data | Where | Kept | Disposal | Enforced by |
|---|---|---|---|---|
| Transactions, statements, receipt photos, budgets, goals, forecasts | Consumer's device only | Until the consumer deletes them, deletes the account on that device, or clears the app's storage | Deleted from the device's storage | The app (account deletion wipes that device's data) |
| Receipt photos | Consumer's device only | 90 days, 1 year or forever, as the consumer chooses | Photo deleted; the entry stays | The app, on every open |
| Transactions, balances and card details from Plaid | Passed through our server in memory | Never stored on our servers | n/a | Design; an automated test checks no table can hold them |
| Plaid access tokens | Database (encrypted twice) | Until disconnect, account deletion, or 60 days without the app being opened | Revoked at Plaid, then deleted | `stackd-api revoke-links`, daily; deletion waits until every token is revoked |
| Account: email, display name, passkey public keys, settings, plan and plan history (trial, purchase, switch, cancel, end: plan, period, amount, dates) | Database | While the account exists; an account whose free trial or plan ends without a new plan is closed and deleted here 7 days later (emails 2 days before the end, at the end and on each of the 7 days; the device keeps its own copy until the consumer decides) | Deleted | `stackd-api plan-lifecycle` (hourly) starts the deletion; `stackd-api purge-deleted` (section 5) |
| One trial per email (a keyed pseudonym of the address and the plan tried) | Database | Kept, also after the account is deleted, to prevent repeat free trials | Deleted at the yearly review if the trial offer ends | Owner, yearly review |
| Signed-in devices (sessions) | Database | While the account exists; shown to the consumer for 30 days after a session ends | Deleted with the account | `purge-deleted` |
| Challenge records (display name, percentage) | Database | While the account exists | Name removed at once on deletion ("Former member"); records deleted | `purge-deleted` |
| Encrypted backups (and the locked copies of the backup key, in the database) | Object storage | The three newest | Older ones deleted; all of them at once on account deletion or when backup is turned off | `stackd-api purge-backups`, daily; deletion and Turn off |
| Household shared data (encrypted) | Database | While the member is in the household | That member's own shared data is deleted when they leave or delete their account | The app (leave) and account deletion |
| Notification settings, push addresses, alert schedule, sent-alert record | Database | While the account exists | Push addresses switched off and unsent alerts dropped at once on account deletion; the rest deleted with the account; a push address is switched off as soon as a push service reports it no longer exists | `purge-deleted`; alert dispatch |
| Security (audit) log | Database | 13 months | Deleted | `stackd-api purge-audit`, daily |
| Sign-in codes | Database | Expire after 10 minutes; deleted after 1 day (never during an active lockout) | Deleted | `stackd-api purge-expired`, daily |
| Passkey challenges, bank-link sessions | Database | Minutes; deleted after 1 day | Deleted | `purge-expired` |
| Sign-in-with-phone requests: the requesting browser and system (for example "Chrome on Mac"), keyed hashes of its code, secret and network address, and who approved it | Database | Expire after 2 minutes; deleted after 1 day | Deleted | `purge-expired` |
| Rate-limit counters | Database | Deleted after 2 days | Deleted | `purge-expired` |
| Household invites | Database | 7-day codes; deleted a week after they expire | Deleted | `purge-expired` |
| Payment-webhook event ids (to ignore redeliveries) | Database | 13 months | Deleted | `purge-expired` |
| Server logs | Hosting provider | 30 days | Deleted by the provider's retention setting | Log retention configured with the production deployment |
| "Before you subscribe", plan-change and cancellation agreements (what was shown and ticked, plan, price, time, keyed pseudonyms of the email, the email inbox and IP, the device label, the Stripe customer reference that paid; no card data) | Database | 7 years, also after account deletion (the account link is removed; payment disputes and tax records: a dispute lost or a fraud refund after the deletion still blocks the inbox) | Deleted | `purge-expired` |
| Purchase blocks (a keyed pseudonym of the email inbox, the reason: a lost dispute or a fraud-warning refund) | Database | Until lifted by hand, also after account deletion (so the inbox can't buy again) | Deleted by hand | none |
| Payment details and payment records | Stripe | As Stripe and the law require for financial records | Stripe's processes | Stripe |
| Messages sent to our email addresses | The owner's inbox (forwarded by ImprovMX) | As long as needed to answer the request | Deleted by the owner; checked at the yearly review | Owner, yearly review |

## 5. Account deletion

Consumers delete their account in the app (Me → Delete account, two taps) or, without signing in, at https://qash.solutions/delete-account (confirmed with an email code). An account is also closed 7 days after its free trial or a cancelled plan ends with no new plan (owner decision, October 14, 2026: there is no lasting free plan); the consumer is emailed 2 days before the end, when it ends and on each of the 7 days, and can subscribe or export throughout; what the server kept is then deleted as below, while the copy on the consumer's device stays there until they download or erase it (the server tells that device the account closed because its plan ended, not because they asked; October 20, 2026).

- **At once:** any live Stripe subscription is ended with no further charge (if Stripe cannot be reached, it is retried hourly and the final deletion waits; a Founding bank payment that clears after the deletion is refunded in full), every session is ended, passkeys and sign-in codes are deleted, every push address (browser and phone) is switched off and alerts not yet sent are dropped, so nothing more is sent, encrypted backups are deleted, bank connections are revoked at Plaid (or retried daily if Plaid cannot be reached), the consumer leaves any household, the display name is removed, the email is replaced by a placeholder, and, when deletion starts in the app, the app's data on that device is erased; any other device erases its copy the next time the app opens there, if that is within the 30 days before the final purge (the server tells it once); after that, the consumer deletes the app or clears its data on that device.
- **Within 30 days:** `stackd-api purge-deleted` permanently deletes the account's remaining records. The final deletion waits until every Plaid token has been revoked. Each permanent deletion is recorded in the security log by the account's internal id only (no email, name or IP), and that record follows the log's own 13-month retention.
- **Kept after deletion:** security-log entries for the rest of their 13 months (no financial data), and Stripe's payment records as the law requires.

## 6. Disposal methods

- **Database records:** deleted (SQL `DELETE`), not flagged as hidden.
- **Object storage (backups):** objects deleted through the storage API. The production backup storage is configured to keep no older versions, so a deleted backup is gone (set when the production bucket is created; `docs/ops/aws-hosting.md`).
- **Plaid access:** revoked at Plaid (`/item/remove`) before our copy of the token is deleted, so no live access is left behind.
- **Device data:** deleted from the app's storage on the device by the app.
- **Physical media:** our data is held only by AWS, whose data centres wipe and destroy storage media to industry standards (NIST 800-88). We hold no physical copies.

## 7. Consumer requests

- **Export:** Me → Download all my data, at any time.
- **Deletion:** as in section 5.
- **Other requests** (including those under state privacy laws such as California's): by email to privacy@qash.solutions from the account's address. We confirm identity, answer within 30 days, and handle appeals within 45 days. Using these rights never changes how a consumer is treated.

## 8. Legal holds and exceptions

If the law requires us to keep specific records (for example, a court order), the security owner may suspend their deletion, in writing, for that purpose and period only; the hold is recorded in `risk-assessment.md` and lifted when it ends. Any other exception to this schedule needs the security owner's written approval with a reason and an end date.

## 9. Compliance and review

- The schedule supports US federal and state privacy laws: deletion on request, data minimisation, no sale of personal information, and secure disposal (as the FTC Safeguards Rule expects). The public wording gets a one-time legal review before launch.
- **Review:** the security owner reviews this policy and the schedule at least once a year, and whenever a new kind of data, storage location or provider is added, and records the review in `risk-assessment.md`.
- **Verification:** each scheduled job reports what it deleted on every run; the yearly review checks those runs and samples the database for records past their period.

## 10. Approval

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1.0 | 2026-10-13 | Adopted | Director, Qash Solutions Inc. |
| 1.1 | 2026-10-16 | Trials replace the lasting Free plan: accounts deleted 7 days after a trial or plan ends without a new plan; one trial per email; "Before you subscribe" agreements kept 7 years; account deletion ends any live Stripe subscription first | Director, Qash Solutions Inc. |
| 1.2 | 2026-10-18 | Plan-change and cancellation agreements are kept the same way as purchase agreements; plan history kept with the account | Director, Qash Solutions Inc. |
| 1.3 | 2026-10-19 | Sign-in-with-phone requests: what is kept and for how long | Director, Qash Solutions Inc. (approved 2026-10-27) |
| 1.4 | 2026-10-20 | A plan that ends without a new one: daily reminder emails for the 7 days, the account closed after them, and the device's copy kept until the consumer decides | Director, Qash Solutions Inc. (approved 2026-10-27) |
| 1.5 | 2026-10-27 | Purchase agreements also keep the inbox pseudonym and the Stripe customer reference, so a dispute lost or a fraud refund after the account is deleted still blocks the inbox | Director, Qash Solutions Inc. (approved 2026-10-27) |
| 1.6 | 2026-10-27 | Each permanent account deletion is recorded in the security log by the account's internal id only | Director, Qash Solutions Inc. (approved 2026-10-27) |
| 1.7 | 2026-10-28 | Account deletion switches off every push address and drops unsent alerts at once; a Founding bank payment that clears after the deletion is refunded in full | Director, Qash Solutions Inc. (awaiting approval) |
