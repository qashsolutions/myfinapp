# Bank and card linking (Phase 3)

*Version 1.1, effective October 16, 2026 (first adopted October 13, 2026). Owner: the Director of Qash Solutions Inc. Chunk 3.1 of docs/spec.md: "Provider chosen; per-connection cost fits the plan price". Linking stays off in production until Plaid approves production access: the API offers it only when the `STACKD_PLAID_*` settings are present.*

This is the record behind the bank and card linking section of docs/spec.md: read-only, on the Connected plan, and part of launch (owner decision, October 12, 2026). The public wording on the website and in the app must match what is written here.

## Provider

**Plaid**, chosen for the build on October 11, 2026, when the owner opened a Plaid account and enabled the sandbox. Stripe Financial Connections was the other option in the spec.

| | Plaid | Stripe Financial Connections |
|---|---|---|
| Coverage (US banks and card issuers) | Broad; liabilities data for credit cards | Banks well covered; no credit-card liabilities data |
| Card details (chunk 3.5: statement balance, due date, minimum, limit, APR) | `/liabilities/get` | Not available, so 3.5 could not be built |
| Linking screen without third-party script in our app | Hosted Link: the user is sent to a Plaid page and comes back | Stripe.js in the page |
| Pricing | Per connected Item per month, per product: Transactions $0.30, Liabilities $0.20 (Plaid's rate card, October 13, 2026) | Per account and per refresh: not quoted |

Card details decided it: chunk 3.5 needs liabilities data, and only Plaid provides it.

### Products enabled

| Plaid product | Enabled | Why |
|---|---|---|
| Transactions | yes | Money in & out, the forecast, recurring detection (chunk 3.3) |
| Liabilities | yes | Card statement balance, due date, minimum, limit, APR (chunk 3.5) |
| Recurring Transactions, Enrich, Transactions Refresh | no | Recurring bills and categories come from our own versioned rules; provider categories are ignored (hard constraint 1). Refresh is an extra per-call cost |
| Auth, Identity, Balance, Signal, Transfer, Payments, Investments, Income, Assets | no | Account / routing numbers, identity data, money movement and brokerage are out of scope by spec |

## Cost against the plan price

Connected is $7 a month or $65 a year (`plans.yaml`, owner decision October 22, 2026; $9.99 / $95.88 before), with up to 3 connections.

| Per connection per month | Transactions | Liabilities (cards only) | 3 connections, worst case | Share of the monthly price |
|---|---|---|---|---|
| Plaid's rate card, October 13, 2026 | $0.30 | $0.20 | $1.50 | about 21% of $7 monthly; about 28% of the yearly price (about $5.42 a month); about 48% of a Founding membership ($150 over 48 months, about $3.13 a month) |

An Item is one login at one institution: a checking account, a savings account and a card at the same bank shared in one sign-in are one Item. Most users are expected to link one or two. Plaid's billing documentation answers the partial month: an Item is billed every month while a valid access token exists for it, and an Item created or removed mid-month is billed for the whole month (no pro-rating). So a link we would not keep is never exchanged for an access token (step 3). Still to confirm with Plaid before signing: whether Liabilities is billed on Items with no card, and any monthly minimum or platform fee.

The worst case is 3 card connections, each billed for both products. Connections are counted the way Plaid bills them: one Item (one login at one institution) is one connection, so a bank account and a card shared in the same sign-in count once.

## How linking works

1. **Start.** The user taps Connect on Me → Linked banks & cards. The app runs the step-up passkey check, then calls `POST /api/linking/start`. The server checks the plan's `bank_links_max` and asks Plaid for a link token with `products: [transactions]`, liabilities as optional, `hosted_link.completion_redirect_uri` back to the app, and a pseudonymous `client_user_id` (an HMAC of the user id, not the email). The app sends the browser to Plaid's hosted page.
2. **At Plaid.** The user picks the institution and signs in on the bank's own page (OAuth) or inside Plaid's screen, then chooses which accounts to share. We never see the bank's username or password.
3. **Finish.** Plaid sends the browser back to `/me/linking/done`. The app calls `POST /api/linking/finish`, the server reads the outcome from `/link/token/get`, exchanges the public token for an access token, encrypts it and stores the connection. The account list (name, last four, type) goes back to the device and is **not kept** on the server. Following Plaid's guidance, two links are never exchanged, so no billable item exists for them and their public tokens expire unused: a bank the user already has a working connection to (matched on Plaid's institution id; the app says it is already linked and points to Sign in again), and a link past the plan's limit of connections.
4. **Sync (chunk 3.3).** The device calls `POST /api/linking/{id}/sync` with its cursor; the server opens the token, calls `/transactions/sync` (up to 4 pages of 500 per request; the device asks again while `has_more`), and returns only transaction id, account id, date, direction, cents, the merchant or name text, the pending flag and the pending id, plus each account's current balance. Provider categories, locations, logos, payment channels and counterparties are dropped on the server. Nothing is stored; the connection notes only `last_synced_at`. The device runs the rows through the same masking, fingerprint, categoriser and transfer rules as an uploaded statement, adopts an uploaded entry that is the same transaction (fingerprint, else same day, amount and direction in the same account) instead of adding a second, and saves the cursor with the rows in one transaction. It pulls on open, on return to the foreground and every 15 minutes, and only if it has a linked account.
5. **Webhooks.** Plaid posts to `POST /api/webhooks/plaid` (set `STACKD_PLAID_WEBHOOK_URL`). The `Plaid-Verification` ES256 JWT is checked against Plaid's published key, must be under 5 minutes old and must carry the SHA-256 of the exact body. The webhook carries no transaction data and we fetch none: it only flags the connection (`updates_available`, `login_required`, `revoked`, repaired), and the device pulls next time it opens. Plaid's keys are cached for a day and a key Plaid marks `expired_at` verifies nothing; an unknown key id is remembered for 10 minutes and at most 10 key lookups go to Plaid a minute, so made-up key ids can't make us call Plaid on every request (October 24, 2026).
6. **Disconnect.** One tap, with no step-up so leaving is never harder than joining. The server calls `/item/remove`, which revokes the token at Plaid, then deletes our copy. If Plaid can't be reached the connection is marked `revoke_pending`, disappears for the user at once, and `stackd-api revoke-links` retries it. Nothing brings it back: Plaid's webhooks, a sync, a card read or a relink leave a `revoke_pending` connection as it is (one conditional update, `app/linking/status.py`), and only a revoke that succeeds ends it (October 29, 2026). Account deletion does the same, and the final purge waits until every token is revoked.
7. **Dormancy (chunk 3.4).** A connection unused for 60 days (opening the app counts: the pull it makes on open, `POST /api/linking/{id}/sync`, even when the bank asks for a new sign-in; reading `GET /api/linking` writes nothing, October 28, 2026) is revoked by `stackd-api revoke-links`, audited as `bank_auto_revoked`, and its owner gets an always-on email; the device drops the link on its next open and keeps every entry.
8. **Reads need a plan that links (October 24, 2026).** Sync, card details and Sign in again answer 403 `plan_required` once the Connected plan or trial has ended: connections are kept so resubscribing picks up where it left off, but neither the bank's data nor the per-connection bill runs on for free; the account's deletion, 7 days after the plan ends, revokes them.
9. **Sign in again.** When the bank asks for a fresh sign-in (`ITEM_LOGIN_REQUIRED`, from a sync or a webhook) the app offers Sign in again: Plaid's update mode on the same item, no new products, finished through the same `/finish`.

The app never loads Plaid's JavaScript. Hosted Link keeps third-party code off our origin, so the app's "loads no third-party resource" rule still holds.

## What the server stores per connection

| Field | Why |
|---|---|
| user id | Owner |
| provider `item_id` | Needed for webhooks and `/item/remove` |
| access token, encrypted | The only way to read the connection; never sent to the device |
| institution name | So the list of connections and the security alert can name the bank |
| Plaid's institution id | So a second link to a bank the user already has is refused before it becomes a billable item |
| status (ok / login required / revoked), created, last used, last synced, updates available | Disconnect, the 60-day dormancy rule, and telling the device when to pull or ask the user to sign in again |

Nothing else: no account numbers, no balances, no transactions, no account names. Transactions and card details are fetched on request and passed straight through to the device (chunk 3.3). The `/transactions/sync` cursor is held by the device, so the server keeps no reading state either.

## Token handling

- Encrypted with AES (Fernet) under `STACKD_LINK_TOKEN_KEY`, a key used for nothing else. In production it comes from the host's secret store, or a KMS-wrapped key when the host provides one. Rotating it means re-encrypting every row; the key id is stored with each token.
- Decrypted only inside the request that calls Plaid; never logged, never returned to the device, never in an export.
- The Plaid client id and secret live only in the secret store (`services/api/.env` locally, gitignored). They are never in chat, in git or in CI logs.
- Outbound calls go to `sandbox.plaid.com` or `production.plaid.com` only, through `outbound_client`; both are on the network allowlist.
- A failed Plaid call logs the endpoint, HTTP status, Plaid's `error_type`, `error_code` and `request_id` (what Plaid support asks for), and nothing else: no tokens, request bodies or Plaid's error message, which can name the bank.

## What Plaid shows users

Set in the Plaid dashboard on October 16, 2026, on the default Link customization (the one our link token uses, since it names no other):

- **Use cases** (Data Transparency Messaging, chosen from Plaid's fixed list): "Track and manage your finances", "Pay down debt", and "Track, manage, and build your credit". The first two match what is built. Tracking and managing credit is built (card utilization, pay in full, due dates, the payoff planner), and since October 28, 2026 so is **Credit habits** (spec "Bills & debt"): on-time payments by each due date, the share of the limit used against a 30% guide and paying the statement in full, from the person's own card data on the device, education only, with no score and no bureau data. Nothing on the website or in the app claims Qash raises a score.
- **Summary of the data we access**, given to Plaid for its other platforms: "Qash reads your account names, balances, transactions and credit card details (balance, credit limit, minimum payment, due date and interest rate) so you can see where your money goes. It uses them for your budget, savings goals and upcoming bills, and to track and pay down card debt. Access is read-only and can never move money. Your transactions are kept on your device, not on our servers; if you turn on backup, it is encrypted on your device with a key we never have."
- **Logo** for OAuth registration: the Rising Q (the same mark as the app and website).

A change to any of these in the dashboard is recorded here.

## Checks before production

- [x] Plaid's rate card is filled in above, and the cost fits Connected's monthly and yearly prices (the Director, October 13, 2026). The Founding price is thin at 3 connections, so Founding memberships are limited in number; the limit is set before the offer opens.
- [x] Plaid production access is approved: company profile, security questionnaire, the privacy policy at `https://qash.solutions/privacy` naming Plaid. *Approved October 16, 2026; the four security attestations were submitted the same day.*
- [ ] Plaid's terms and data agreement are signed (security owner); the privacy policy names Plaid (done: https://qash.solutions/privacy).
- [ ] OAuth institutions: the redirect URI is registered in the Plaid dashboard for the production app host.
- [ ] The website's security page and the in-app link screen match this document (security owner).
- [ ] `docs/security/vendors.md` row moved to approved (security owner).
