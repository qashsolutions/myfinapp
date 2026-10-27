# Apple privacy labels (draft until the owner signs)

Apple counts data as "collected" when it is sent off the device and is readable by us. Money
data (transactions, statements, receipts, budgets, goal amounts) never leaves the device in
readable form, and the optional backup is end-to-end encrypted with keys we never hold, so it
is **not collected** under Apple's definition. What the server does hold:

**Data linked to you**

| Apple category | What | Purpose |
|---|---|---|
| Contact info → Email address | Sign-in and security alerts | App functionality |
| User content → Other (display name, optional) | Shown to group members you join | App functionality |
| Identifiers → User ID | The account id; also the push token for alerts | App functionality |
| Purchases → Purchase history | Your plan (Stripe or App Store subscription state) | App functionality |
| Other data → Group progress (a percentage only) | Challenge leaderboards | App functionality |

**Data not linked to you:** none collected.
**Tracking:** none. No ads, no analytics, no third-party SDKs that collect data.

Notes for the reviewer filling the form:
- Health, financial info, location, contacts, browsing, search history, diagnostics: **not
  collected**. (Financial info is the point: it stays on the device.)
- Security audit logs keep a pseudonymised (hashed) IP for abuse protection; Apple's form has
  no clean slot for a hash that cannot be reversed to an IP — the owner to confirm whether to
  declare under "Identifiers". Flag this in the review notes rather than over- or
  under-declaring silently.
- Push tokens are stored encrypted and deleted when notifications are turned off.
