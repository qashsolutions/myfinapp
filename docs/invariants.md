# Invariants

Rules that must hold whatever the person does and in whatever order. Each names the tests that
guard it. A change that touches one of these data paths is not done until its rule still has a
test that would fail if the change broke it.

Most of the defects found in review (October 25, 2026) were one of two kinds: a fix applied to one
path but not its sibling, or two features that each work but break together. The rules below are
written against both.

## Money is counted once

1. **Every bank cent counts once.** An imported, linked, split, renamed or posted entry, plus its
   split parts, adds up to the bank's row. Split parts never carry `provider_txn_id`; sync sets
   the entry to the bank's amount minus all its parts, a part split again included (parts are
   collected all the way down, for the sum and for removal; October 28, 2026). Every balance
   (Next 30 days, net worth and its history) counts the entry and all its parts; readers that
   compare with the bank's amount (recurring payees, matching upcoming bills) use
   `entries/splits.ts` `bankRows`.
   Deleting a part in the editor gives its amount and its own parts' back to the entry it was
   split from, and a part's new amount moves the difference there (`splits.centsBackToParent`;
   October 28, 2026).
   `apps/web/tests/invariants/money-month.test.tsx` "a part split again…", "a split entry
   after the balance…" · `splits.test.ts` · `entries.test.tsx` "deleting a split part gives its
   money…", "a part's new amount moves the difference…" ·
   `linked-sync.test.tsx` "a split linked entry"
   · `money.test.tsx` "splits an entry into two parts that still add up"
2. **A transfer is both sides or neither.** Marking, matching or unmarking one side does the same
   to the other, linked by `transfer_pair_id`.
   Marking by hand (the entry editor, Sort your spending) pairs the matching other side through
   `entries/transfers.ts`, the same rule import and sync use. Import, sync and marking by hand
   take one candidate test, `transfers.isTransferCandidate`: not already a transfer or paired,
   not pending, never a split part or parent, and never a row the same sync page removes
   (October 28, 2026). A split part (or a split parent) is never
   a transfer side; both sides posting in one sync page stay paired; when one side goes
   (deleted, with its account, or by the bank) the other counts again (`releasePartners`).
   `import-flow.test.tsx` "an import never offers a split part…" · `linked-sync.test.tsx` "a
   transfer is never paired with a row the same page removes" ·
   `import-flow.test.tsx` "a confirmed transfer marks both sides…", "unmarking one side…",
   "marking an entry a transfer by hand…" · `review.test.tsx` "a transfer marks and pairs…" ·
   `linked-sync.test.tsx` "a split part is never taken…", "both sides … in the same page…",
   "a row the bank removes…" · `import-flow.test.tsx` "deleting one side of a transfer…" ·
   `money-month.test.tsx` "a transfer marked by hand…" ·
   `linked-sync.test.tsx` "a card payment from checking pairs…", "a posted transfer stays paired…"
3. **Every screen shows the same month.** Home, Money in & out, Insights and the recap read one
   set of rules over the same entries (`counted()`, transfers out), so their numbers agree.
   `money-month.test.tsx`
4. **Don't count leaves spending, never balances or net worth.**
   `not-counted.test.tsx`
5. **A jar's balance is deposits minus withdrawals, everywhere; moving between jars sets nothing
   aside.** Any reader of `goal_events` reads withdrawals; "set aside" counts `newMoneyIn`.
   `home.test.tsx` "money moved out of a jar…" · `recap.test.tsx` · `money-month.test.tsx`

## What the person did survives

6. **Edits survive a sync.** A name, category, note, tags, Don't count, transfer and recurring
   marks, a receipt and a split survive an update and a pending row posting.
   `linked-sync.test.tsx` "keeps the person's names…", "a posted row keeps what the person did…"
7. **A queued server value is never lost to an older send.**
   `server-queue.test.ts`
18. **A write applies to what is stored now, and the newest input wins.** Budget moves, assigns,
    their undos and Start from last month read the stored line inside their transaction, never
    a screen's snapshot; an undo reverses its own amount and keeps edits made since; a screen
    that saves on every keystroke (Later) saves only the newest one. A form filled from stored
    values takes input only once they are in, and never reloads them over what the person is
    typing (the entry editor waits for its entry; Budget's pay form fills once; October 27,
    2026). A bank sync plans a page from a read, then checks every row it read inside its write
    transaction; one changed meanwhile means the page is planned again from what is stored now
    (October 28, 2026).
    `linked-sync.test.tsx` "an edit saved while a sync is working survives it…" ·
    `seams.test.ts` · `later-order.test.tsx` · `tags-notes.test.tsx` "the editor takes no
    input…" · `budget.test.tsx` "editing a saved paycheck…"

## Nothing hangs, nothing leaks

8. **No screen waits forever for a number, or shows one for something else.** The engine
   answers or fails every call, also when the worker cannot load (one call that throws fails
   alone, and a worker that crashes after working is replaced, so heavy calls stay off the
   page); a screen never asks it for a range that ends before it starts (Money in & out stops
   at this month), and a hidden card's picture (the what-if line) goes with it.
   `engine.test.ts` · `money.test.tsx` "never steps past this month…" · `forecast.test.tsx`
   "drops the what-if line when the Try card is hidden…"
9. **Money data never leaves the device** (statements, entries, receipts, amounts, merchants);
   only ciphertext, group percentages and dates / types / keys for alerts do. The sweep reads
   every request whole: the URL with its query string, every header and the raw body (October
   28, 2026). A receipt photo keeps no metadata wherever it hides: between scans, or after the
   end of the image (a phone's second JPEG with its own EXIF, a motion-photo video).
   `leak-sweep.test.tsx` (with "the sweep itself") · `import-flow.test.tsx` `onlySessionReads` ·
   `groups.test.tsx` · `notifications.test.tsx` · `receipts-strip.test.ts`
10. **The two engines agree.** Python and TypeScript answer every golden case the same way, and
   no rule returns an amount past 2^53 − 1 cents (JavaScript's largest exact integer): the growth
   rules answer `too_large` there, with goldens on both sides of the line. Text and dates are
   the known traps (October 27, 2026): strings are ordered by code point (`text.ts`
   `compareText`, never `localeCompare` or `<`), whitespace is one spelled-out list in both
   engines, n-grams count characters, and years 1–99 are those years. Each trap has a golden that
   fails on one side if it comes back (`*_by_character_code`, `*_by_code_point`,
   `whitespace_is_one_list`, `year_*`, `ngrams_count_characters_not_utf16_units`).
   The app follows the same rules (`lib/order.ts`, `@stackd/rules/dates`).
   `services/rules/tests` · `packages/rules` (`text.test.ts`) · `apps/web/tests/engine/golden.test.ts` ·
   `apps/web/tests/unit/text-and-dates.test.ts`

11. **An error never fails silently.** On the server it emails the admins (type and place only,
    throttled, never raising itself); in the app a broken screen shows a way out and sends nothing.
    A new payment dispute always reaches the admins, also when no plan in the app matches it,
    since Stripe wants evidence before its deadline either way.
    `services/api/tests/test_ops_alerts.py` · `crash-screen.test.tsx` · `test_billing_hardening.py`
    "a dispute on a charge no plan matches still reaches the admins"

20. **"Nothing there" means nothing is there.** An answer that tells the device there is
    nothing (no backup, nothing older) is never given for a reference that went stale
    meanwhile: a `before` copy pruned while a restore walked back answers 409 `backup_gone`,
    and the device starts again from the newest, skipping copies it already could not open.
    `test_backup.py::test_stepping_back_from_a_pruned_copy_says_so_instead_of_no_backup` ·
    `backup-walk.test.ts`
21. **A backup is one moment, and a merge keeps what is newest** (October 28, 2026). A snapshot
    is read in one transaction, so a delete and its tombstone are both in it or both out. A row
    whose id can come back (a milestone is `<goal>:<bps>`) syncs newer-wins by `updated_at`, and
    adding it back clears its own tombstone, so an old removal from another device never
    deletes it again (and its cheer never plays twice). A merge skips only a row a unique index
    already holds, when adding it or writing a newer copy, and counts it; any other failure
    stops the merge, and a pull that fails still lets the device push its own backup (nothing
    is pruned then).
    `backup.test.ts` "a milestone removed and added back…", "a row a unique index already
    holds…", "a newer row a unique index already holds…", "builds the snapshot in one read
    transaction…" · `backup-prune.test.ts` "a merge that fails still lets this device push…"
22. **Removing something removes what hangs off it** (October 28, 2026). An account takes its
    entries, imports, anchors, mapping and kept files, its entries' receipts and photos, its
    card details and its net worth choice (with a tombstone where the table syncs); an entry
    takes its split parts (a part's parts too) and its receipt and photo, also when the bank
    removes it; a photo replaced on an entry takes its old receipt, and so does one the person
    removes, one or all (retention takes the photo and the text read from it). Nothing is left on the device that no screen can
    reach.
    `settings-data.test.tsx` "manages accounts…" · `entries.test.tsx` "edits and deletes an
    entry…", "deleting a split entry…" · `linked-sync.test.tsx` "a row the bank removes takes
    its receipt…" · `receipts.test.tsx` "replacing an entry's photo…", "removing a photo removes
    its receipt record too…"
24. **Forgetting an old removal never brings the row back** (October 28, 2026). Tombstones older
    than `TOMBSTONE_HORIZON_DAYS` (180) are dropped only after a sync, with backup on and the last
    full pull within the horizon; never with backup off, never during a merge, never in tables
    whose rows may have no time (`UNSTAMPED_TABLES`). The newest dropped `deleted_at` is kept
    (`backup.tombstones_pruned_before`, device-only) and sent in every snapshot; a merge never adds
    a row this device lacks whose own time is at or before it, and takes a newer record from any
    snapshot it merges. Absence in a snapshot never deletes; only a tombstone does.
    `backup-prune.test.ts`
25. **The export holds everything the person made** (October 28, 2026). Every Dexie table is in
    "Download all my data" except device-only bookkeeping a restore rebuilds (`computed_results`,
    `forecasts`, `server_queue`, `tombstones`, named in `data/export.ts`), kept statement files
    included, and entries carry what rebuilds their splits and pairs. A new table joins the
    export or that list.
    `settings-data.test.tsx` "the export holds everything the person made…"
28. **Qash says only what the person's own data shows** (October 28, 2026). It cannot see
    whether a service is used, so the subscription check asks ("Still using …?") and states
    facts from the charges (a price rise, a trial that became a charge, a renewal, services of
    one kind); it never says "unused", never pushes or emails about it, and nothing about it
    leaves the device. Fixed vs flexible splits the same Month Out (fixed + flexible = Out) and
    keeps the same Kept as Money in & out.
    `subscription-check.test.tsx` · `fixed-flexible.test.tsx` · `money-month.test.tsx` "Fixed vs
    flexible splits the same Out…"
29. **An alert key never names a category or an amount** (October 28, 2026). A budget alert
    leaves the device as a date, the type `budget_pace` and `budget:<YYYY-MM>:<tag>:<level>`,
    where the tag is 16 letters a–p (`alerts.tag`: FNV-1a over a random value kept on the device
    and the category's id, so the server cannot work back from it). `alerts.schedule` refuses any
    other tag and the API refuses any other key shape; the push label is fixed text. "What
    helped" answers leave as choice ids from the fixed list only, and the group sees totals only:
    a member sees them once at least two members other than themselves answered (signed off by
    the owner, October 29, 2026), so no one can take their own answer away and read another's; leaving
    or being removed clears the answer, and rejoining starts without it
    (`tests/test_group_helped.py`).
    golden `alerts.schedule/budget_tag_must_be_letters` · `notifications.test.tsx` "a budget
    alert carries a month, a tag and a level…" · `test_budget_alerts.py` · `leak-sweep.test.tsx` ·
    `test_group_helped.py` · `budget-helped.test.tsx` "What helped"
30. **One reading, said once, wherever it appears** (October 28, 2026). Where two screens show
    the same thing they read it through one helper: Budget's "Close" / "Over", the budget alert
    and the month review's lines over all use `paceLines` (something planned, never the save
    bucket) at `alertLevels` of the person's own "Tell me at", and each bar's ticks sit at that
    same level (`closeLevelBps`). A line the person switched off (`budget.alert_off`, October 29,
    2026) leaves the alert only (`alertLines`), never the reading: its word and bar stay, and it
    makes no schedule item at all (`adjust-visuals.test.tsx`). A jar that grows over time is
    read only by `growth.goal_plan` / `goal_pace`: no flat weekly pace on its screen, list row
    or quick chip, no behind-pace alert or Home move, no What if months-to-fill. A screen that
    gathers other cards (the month review) never repeats the word or the number another of its
    cards already leads with.
    `month-review.test.tsx` "builds over_plan…" · `budget-helped.test.tsx` "Close follows the
    person's own Tell me at…" · `grow-whatif.test.tsx` "a grows jar shows one monthly amount…",
    "never feeds the flat behind-pace alert", "Spend less never fills a grows jar"

## Accounts and money on the server

12. **Every deletion path locks the person before their plans**, the order every Stripe webhook
    uses (`deletion._lock_person`, `stripe_billing._lock_person`); one account failing never stops
    a purge batch. A deletion Stripe couldn't be told about is retried within the hour and
    refunded as of the deletion day; a charge made after it is refunded in full.
    A refund that can never be paid (the payment was disputed meanwhile) is dropped, never
    retried for ever, and the hourly settle picks up only what still has something to do.
    Stripe not answering at all (a dropped connection, a timeout) is the same outage as a 5xx.
    A Founding payment that lands after the deletion is refunded in full and grants nothing.
    Every per-account job (purge, settle, plan lifecycle) runs each account in its own
    savepoint: one failing never undoes or re-sends another's.
    `test_billing.py` "the purge takes the person before their plans…", "one account failing in
    the purge…" · `test_billing_hardening.py` "a founding payment disputed after its deletion…" · `test_billing_change.py` "deleting while Stripe is down…", "a late retry still
    refunds as of the day…", "a renewal charged after the deletion…", "deleting while Stripe
    cannot be reached…", "one account Stripe cannot reach…", "a disputed plan deleted is
    settled once…" · `test_founding_cap.py` · `test_trials.py` "one account failing never
    undoes or resends…"
13. **A webhook delivered twice, late or out of order changes nothing more; a refund is paid once.**
    Stripe dates events to the second, so two in the same second are settled by reading the
    subscription from Stripe, never by which arrived last. A plan starts only once its money
    has arrived, and a payment that failed stays failed, whatever order its events come in.
    A checkout completion never stamps the row's newest event (it isn't the subscription's own),
    and a genuine event signed during a secret roll (two v1 values) is accepted.
    The store proofs follow the same rule: an older signed Apple transaction never overrides a
    newer one, a Play token is checked against its pattern before it goes into a URL, and a
    proof that belongs to another account is refused (409), never quietly applied.
    `test_billing.py` "a signature header with several v1 values…" ·
    `test_billing_fixes.py` "an old apple transaction…", "a play token outside the pattern…",
    "a proof already linked to another account…" ·
    `test_billing_hardening.py` "a subscription created dated before its checkout…"
    `test_billing_hardening.py` "a late checkout completion…", "events in order…", "a founding
    refund is paid once…", "two events in the same second apply what Stripe holds now", "a failed first bank payment delivered before its checkout…", "a bank-funded subscription announced before its checkout…"
14. **A limit has one count, read the same way everywhere, and is taken under a lock.** The
    Founding places shown on the pricing page are the ones the webhook will grant; the count and
    the row that takes a place happen under one lock for the offer.
    The same for every count-then-write on the server: bank links against `bank_links_max` and
    a link session finished once (`linking.finish` locks the person, then the session), and the
    last passkey (removal locks the person before counting).
    Never two plans at once: while a first bank payment clears (or a Founding place is held),
    or beside a live App Store / Google Play plan, checkout answers 409 and the Plan screen
    says why (one helper, `entitlements.payment_pending`, for both).
    `test_billing_fixes.py` "no second purchase while…", "web checkout refuses beside a live
    store plan" · `billing.test.tsx` "a bank payment still clearing…" ·
    `test_billing_hardening.py` "a failed bank payment never shrinks the cap…", "two buyers
    paying for the last place at once…" · `test_linking.py` "two finishes of one session…",
    "two sessions with one place left…" · `test_auth.py` "two removals at once…"
15. **Every access state says what is true and has a way forward.** Paused only while a dispute
    is open (it can come back); a lost one is `ended`, open and never closed for it, as the terms
    say; lapsed closes after the grace period with emails that never invite a blocked inbox to
    buy. Every state the app gates (`AccessGate.accessRoutes`, one table) can always reach
    deletion, and every state that may buy can reach the plans: someone signing up again with an
    inbox whose trial was used (`choose` with `trial_used`) is told so on /start and led to the
    plans, and the offer to bring kept data back is made there too (October 28, 2026). A plan
    whose money never arrived (a failed first bank payment, a Founding place given back) never
    started, so it never ended: the account stays where it was, its trial still on offer.
    Founding ends with its term, with the same notes as any plan's end.
    `test_billing_hardening.py` "a lost dispute ends the plan but the account stays open…", "a
    fraud refund lapses with honest notes…" · `trials.test.tsx` "a lost dispute ends the plan…",
    "every access state reaches what it may…", "a returning person whose trial was used…" ·
    `test_trials.py` "signing up again says the trial was used…" · `e2e/returning.spec.ts` ·
    `test_billing_fixes.py` "a failed first bank payment keeps the trial…", "founding ends
    with its term…", "receipts stay reachable after a plan ends"
16. **Every route needs a session unless it is public on purpose, and someone else's row is 404.**
    `tests/security/test_route_guards.py` · `tests/authz/`
17. **A purchase block follows the person.** After a lost dispute or a fraud refund, every
    inbox the person bought with can't buy again: across an email change, a deletion and the
    purge (found through their purchase records). A card or bank block Stripe couldn't take is
    said to the admins, never silent.
    `test_purchase_blocks.py` · `test_billing_hardening.py` "after a lost dispute the inbox and
    card cannot buy again…"
19. **Every permanent erasure leaves a record that outlives it.** The purge writes one audit row
    (`delete_completed`, `user:<id>`, no person and no IP) for each account it erases, and none
    for an account it keeps; every audit action in the closed set is one the server writes.
    `test_account.py` "the purge is audited…" · `tests/security/test_audit.py`
23. **A deleted account hears nothing more.** Deletion switches off every push subscription
    (browser and native) and drops unsent alerts; the dispatcher and the recap scheduler skip
    deleted accounts even if a row slips in. The plan-ended closing email is the one exception,
    sent by the job that closed it.
    `test_notifications.py` "a deleted account gets no pushes…"
26. **The auto-lock counts only what the person does** (owner decision, October 28, 2026). A
    call the app makes on its own (backup and household sync, the linked-bank pull, the alert
    schedule and its reads, entitlements, the server queue, the lock itself) goes through
    `data/api.ts` `backgroundApi` / `clientFor(true)` and carries `X-Qash-Background: 1`;
    `principal.counts_as_activity` never touches the session for it, nor for a request the
    browser marks as from another site (`Sec-Fetch-Site` present and not `same-origin`) or a
    page load (`Sec-Fetch-Mode: navigate`). When the screen locks, `POST /api/auth/lock` locks
    the session on the server (`sessions.locked_at`) until the next passkey check. A new timer,
    sync or refresh uses the background client; a call made for a tap or an opened screen stays
    on `api`.
    `test_activity_lock.py` · `background-calls.test.tsx`
27. **A request is answered once.** A Link with your phone request is approved or denied once,
    then closed: a second answer, or one after it expired, is 409 and changes nothing (the row,
    the audit log, the computer's sign-in). Each Founding reminder (30, 7 and 1 day before, and
    the day it ends) goes out once, stamped in the same savepoint that sends it.
    `test_device_link.py` "each request is answered once" · `link-device.test.tsx` ·
    `test_founding_reminders.py`

31. **An older build keeps running on a newer database** (October 29, 2026). A deploy runs the
    migrations as the new API starts; if the new version then does not go live, the old one must
    still start and report ready. Every migration stays backward compatible for one release
    (add tables, nullable columns and wider CHECKs; drop or rename only one release later), and
    `stackd-api migrate` and `/health/ready` treat a revision this build does not know as newer,
    not as an error. Found when deployment 85 migrated to 0036, Lightsail gave up waiting, and the
    old API crashed at every restart until the deploy was re-run.
    `test_health.py` "a newer database keeps this build ready and starting"

## Working to these rules

- **Before fixing**, name the rule the defect broke, and write the failing test first (a
  two-connection test for a lock, a real flow for a cross-feature bug).
- **Sibling check:** find every other path that reads or writes the same data or takes the same
  lock, and fix or confirm each. Where two paths must agree, give them one helper. The commit
  message lists what was checked.
- **Then** run the test against the old code and see it fail, and add a rule here when a new
  kind of defect appears.
- A new money path (a new import kind, a new sync step, a new screen total) joins
  `money-month.test.tsx`.
