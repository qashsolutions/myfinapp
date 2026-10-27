# Play Data safety form (draft until the owner signs)

Same ground truth as the Apple labels: money data never leaves the device readably; the
optional backup is end-to-end encrypted with user-held keys (declare backup ciphertext as
"encrypted in transit" + "user can request deletion"; it is not readable by us).

**Collected and linked to the account:**

| Play category | Data | Purpose | Optional? |
|---|---|---|---|
| Personal info → Email address | Sign-in, security alerts | Account management | Required |
| Personal info → Name (display name) | Shown inside groups you join | App functionality | Optional |
| App activity → Other user-generated content | Group progress, a percentage only | App functionality | Optional (only in challenges) |
| App info and performance | none | — | — |
| Financial info | **Not collected** (stays on the device) | — | — |
| Device or other IDs → FCM push token | Notifications | App functionality | Optional |

**Data sharing:** none. No data sold, no data shared with third parties. Payment details go to
Google Play or Stripe directly; we never see card numbers.

**Security practices:** data encrypted in transit (TLS); users can request deletion (in-app two
taps, and https://[domain]/delete-account); passkey sign-in; independent security review is the
launch gate's outside penetration test (docs/security/security-plan.md §6).

**Deletion:** deleting the account removes server data after the grace period (30 days,
proposed) and the app wipes the device database immediately.
