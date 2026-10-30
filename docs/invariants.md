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
   rules answer `too_large` there, with goldens on both sides of the line. A month-by-month loop
   whose balance can grow (the payoff plan, consolidation, What if's debt lever) stalls instead,
   before a balance with its month's interest or the total owed passes the line, so a high rate
   with no payment is "Stalled", never an error (October 29, 2026;
   `*_stalls_before_the_balance_overflows`, `a_balance_at_the_limit_stalls_in_its_first_month`). Text and dates are
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
    export or that list. It is never a key to the data (October 29, 2026): device secrets and
    sync bookkeeping (`backup.*` with the backup and recovery keys, `household.key`, the alert
    salt and hash, linking cursors) are left out through `EXPORT_LEFT_OUT_SETTINGS`; a new
    secret setting joins that list. Found when the ZIP carried `backup.key`.
    `settings-data.test.tsx` "the export holds everything the person made…" ·
    `export-secrets.test.ts`
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
38. **A month on screen counts up to the day it shows** (October 29, 2026). Stepping to a month
    (Previous / Next) reads it as of today when it is this month, its last day when it is past,
    its 1st only when it is still to come (`engine/bridge.monthViewAsOf`); never the 1st of a
    month that has begun, which left every entry after the 1st out of Budget (Needs read $0.00
    for the same month). Budget and Money in & out step through it; Fixed vs flexible and the
    month review take whole months.
    `budget.test.tsx` "counts the whole of a past month…" · `engine.test.ts` "monthViewAsOf"
39. **A card statement is read as a card** (October 29, 2026). A PDF whose header says it is a
    card (minimum payment due, credit limit, payment due date, available credit, a card word),
    or one imported into a credit-card account, reads purchases as money out, payments and
    credits as money in and its balances as owed (below zero), so net worth and Credit habits
    never see a card as money the person has. Header words come only from lines that are not
    transactions, so a "VISA DEBIT" purchase never turns a checking statement into a card.
    `pdf-import.test.ts` "a credit-card statement without a running balance…", "a PDF going into
    a credit-card account…"
40. **A statement's balance is anchored on its true last row** (October 29, 2026). Whatever
    order a file lists its rows in (oldest first, newest first, several on one day), the
    balance taken from a running-balance column is the one after the last thing that happened:
    the order is read from the running balance, else from the dates (`importFlow.fileOrder`).
    A printed ending balance (OFX, a PDF's) still wins.
    `import-flow.test.tsx` "oldest first, newest first and the same day…"
47. **One merchant, one key, on the bank's own text** (October 29, 2026; owner: "NETFLIX,
    netflix, Netflix.com: they are all the same"). Every matcher of a merchant (bill and income
    detection, upcoming bills against entries, subscriptions and their kinds, Rename all like
    this and saved names, category rules and keywords) compares `fingerprint.merchant_key`
    (cleaned like a fingerprint, then "WWW.", ".COM" / ".NET" / ".ORG", a processor prefix
    before "*", a reference after it and number-only words dropped) of the entry's bank text,
    `db.bankText` (its `clean_description`, else its name for an entry typed by hand), never a
    name the person gave it: renaming "NETFLIX.COM" to anything keeps it on its bill (matched
    as paid, so not taken off twice), its subscription and its saved name. Editing a found bill's
    label keeps its payee; a category rule is made from the bank text. The fingerprint never
    changes, so re-imports stay idempotent.
    `merchant-matching.test.tsx` "renaming a bill's charges…", "rename all like this and a saved
    name…" · goldens `fingerprint.merchant_key`, `forecast.upcoming`
    "bank_text_and_bill_name_are_one_merchant", `recurring.detect`
    "one_payee_however_it_is_written"
48. **An upload never duplicates a linked row** (October 29, 2026). A statement row going into
    an account whose bank sync already wrote a row on the same date with the same amount and
    direction is "already in Qash · skipped", one file row for one synced row (two coffees that
    day, one synced, leave one new), exactly as a sync adopts an earlier upload in the other
    order (`importFlow.prepareRows`, `sync.uploadedTwin`).
    `merchant-matching.test.tsx` "synced first, then the statement…", "the statement first, then
    the sync…" · `linked-sync.test.tsx` "never counts an uploaded entry twice…"
49. **Pay and bills keep the days they are paid on** (October 29, 2026). Pay on two fixed days
    of the month, moved by weekends, is twice a month (`recurring.detect` `semimonthly` with
    its `days`), never every 2 weeks: "Use … as my pay" saves twice a month with those days, so
    $2,500 on the 15th and last day is $5,000 a month, not $5,416.67, and a twice-a-month bill is
    confirmed as one monthly bill per day. A month-based bill keeps its usual day (`day`, 31 =
    the last day) and every reader of a confirmed series passes it to `forecast.upcoming`
    (`useRecurring.seriesInput`), so rent on the 31st is Feb 28 and then Mar 31, never Mar 28;
    a bill confirmed before this reads its day once from its own charges (the same rule) and
    a next date that drifted to the 28th moves back onto it (`useRecurring.backfillSeriesDays`).
    `merchant-matching.test.tsx` "pay on the 15th and the last day…", "a twice-a-month bill…",
    "rent on the 30th, 31st and 31st…", "reads its day once from its own charges…" · goldens `recurring.detect` "twice_a_month_*",
    "true_every_two_weeks_stays_every_two_weeks", "rent_on_the_last_day_keeps_day_31"
50. **A keyword is a whole word, and the longest one wins** (October 29, 2026). One rule decides
    which word counts, for category rules and keywords and for subscription kinds (the person's
    own words first, then the table; `recurring.longest_word`): a whole word
    (`recurring.contains_word`), in the cleaned text or its merchant key, the longest match
    winning, ties by order: UBER EATS is dining wherever
    UBER sits in the table, RENT never hits PARENT or ENTERPRISE RENTALS and SHELL never hits
    SHELLS SEAFOOD. The screens that move entries along with a new rule (the entry editor's
    "Always put…", Sort your spending) ask the engine the same question (`bridge.matchesRule`).
    `services/rules/tests/test_keywords.py` "every keyword reaches its own category", "no keyword
    hits inside another word", "every kind word reaches its own kind" ·
    `merchant-matching.test.tsx` "an import sorts UBER EATS…" · goldens `categorize.match`,
    `recurring.subscription_check` "longest_kind_word_wins_ties_by_order",
    "longest_own_word_wins_and_own_words_come_first"
51. **Only a whole month is history** (owner decision, October 29, 2026). Statements rarely
    start on the 1st: two days of September are September's own numbers, never "September".
    The coverage start (`data/coverage.ts`: the earliest statement period start or first entry,
    over all accounts) must be on or before a month's 1st for that month to be the month before,
    part of an average a month, "usual" or a seasonal month, and on or before a week's first day
    for the recap's week before; a partial month is shown and never compared ("First full month
    here, nothing to compare yet"). Every reader takes the same helper: `useMonthTotals`
    (`previousPartial`), `useRangeTotals` (`average`, the period before), `useFixedFlexible`
    (`compared`, the kept-rate bars), Budget's Start from last month, `useWeekTotals`, and the
    rules `insights.vs_usual` / `insights.seasonal` (`history_from`).
    `money.test.tsx` "never compares with a month the data only partly covers…",
    `insights.test.tsx` "two days of a first month are never usual…", `ranges.test.tsx`,
    `month-review.test.tsx` "never sets October against two days of September…",
    `recap.test.tsx` "never compares with a week the data only partly covers…" · goldens
    `insights.vs_usual` "two_days_of_a_month_are_not_usual", "a_partial_first_month_never_lowers_usual",
    `insights.seasonal` "a_partly_covered_month_is_not_history"
52. **Everyday spending on a schedule is never a bill** (owner decision, October 29, 2026). A
    weekly or every-2-weeks run of money out mostly in an everyday category (config/insights.yaml
    `regular_spending`, or the person's own list in `settings` `bills.regular_categories`) is
    shown as regular spending and never confirmed as it is (`useRecurring.isRegularSpending`;
    `confirmSuggestion` refuses one); the person's own call per merchant (`bills.regular_calls`:
    This is a bill / This is regular spending) always wins, and regular never keeps a bill or
    an `is_recurring` mark (`billToRegular` removes it). So its charges never
    become `is_recurring`, fixed or left out of typical daily spending; Home's Confirm all takes
    monthly-or-longer bills only (`inConfirmAll`). Income runs are always offered.
    `home-visual.test.tsx` "weekly groceries, takeout and gas are regular spending…", "the
    person's everyday categories and their own call decide…", "This is a bill confirms Trader
    Joe's…" · `e2e/regular-bills.spec.ts"
53. **Safe to spend looks through the next whole pay period** (owner decision, October 29,
    2026). With two paydays ahead, the window ends the day before the payday after next, so a
    payday two days away never makes the whole balance spendable in two days; one payday known
    keeps the day before it, none keeps the forecast's days. The rule picks the window
    (`insights.safe_to_spend` `paydays`, out `window` and `payday`) and every screen's words follow
    it (`SafeToSpendLine.safeWindowText`, Home, Insights). `insights.test.tsx` "shows safe to
    spend through the next pay period…" · goldens `insights.safe_to_spend`
    "payday_in_two_days_looks_through_the_next_pay_period", "one_payday_known_ends_the_day_before_it"

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
32. **A count or a single use holds when requests arrive at once** (October 29, 2026). A code's
    wrong attempts, its consumption, and a passkey challenge's consumption are read under a row
    lock (`SELECT … FOR UPDATE`) and written in the same transaction, so twelve guesses sent
    together lock the address after the fifth, the `CODES_LOCKED` alert goes once, and one code
    or one signed passkey answer passes once. The public deletion page checks codes with no
    passkey, so a lost count there was an account deleted by guessing. A new attempt counter or
    one-time token is read with the lock, and its test sends the requests in parallel.
    `test_otp_concurrency.py`
33. **What was sent is recorded as it goes** (October 29, 2026). A job that sends (the alert
    dispatcher's pushes and emails, the weekly recap, the plan-lifecycle emails and pushes)
    commits each send with its log row or stamp at once and handles each person on their own:
    a failure later in the run, or for someone else, is reported (`ops_alerts`) and never makes
    the next run send it again. Found when one failure rolled back a whole minute's log rows.
    `test_alert_delivery_once.py` · `test_founding_reminders.py`
34. **An alert that was skipped can come back; one that was sent never does** (October 29, 2026).
    A key skipped while its type was off (or alerts were paused) is scheduled again when the
    device or the server registers it for a time still ahead; a key in `notification_log` is
    never scheduled again.
    `test_alert_delivery_once.py` "a skipped alert comes back…"
44. **A phone's approval signs a computer in; it is never a passkey check on the computer**
    (owner decision, October 29, 2026). A Link with your phone session opens unlocked
    (`sessions.link_unlocked_at`) with `passkey_verified_at` empty, so every `require_step_up`
    route (and adding a passkey) answers `step_up_required` until the computer itself passes a
    passkey check; the assertion options leave the browser's "use a phone" choice open (no
    transports, no platform hint). Found when the phone's check stood in for the computer's and
    a phished approval had five minutes to add a passkey, change the email or delete the account.
    `test_device_link.py` "a linked computer opens unlocked with no step-up credit…", "assertion
    options leave the phone option open" · `passkey-here-offer.test.tsx`
45. **Removed is not left** (October 29, 2026). The owner removing a member stamps
    `group_members.removed_at`; such a member gets 403 `removed` on lookup and join with the old
    code or a new one, and the app says so plainly. Someone who left may rejoin. Found when a
    removal set the same stamp as leaving and a join reopened it with the unchanged code.
    `test_group_joins.py` · `groups.test.tsx` "someone the owner removed…"
46. **A join is counted and written under the person's lock, then the group's** (October 29,
    2026), like the household's joins (invariant 14). Two joins at once never pass Free's one
    challenge; two joins of the same group at once both answer the one membership (200), never a
    500 from the unique constraint. Leave and removal take the same locks.
    `test_group_joins.py` (parallel requests against Postgres)

41. **Never two plans, however many pages were open** (October 29, 2026). The checkout's 409s
    hold when a page is paid too: every payment page closes after 31 minutes, opening one closes
    the person's others first, and a paid page (or a subscription announced before its checkout)
    that would make a second live plan is ended at Stripe and refunded in full, once, while the
    plan bought first stays. One helper (`entitlements.purchase_conflict`) answers both.
    `test_billing_oct29.py` "every payment page closes…", "opening a payment page closes…", "a
    second paid page is ended and refunded…", "a second subscription announced before…", "a
    second plan paid by bank…", "a founding payment beside a renewing plan…"
42. **A dispute pauses only the plan it paid for, and nothing is collected meanwhile**
    (owner decision, October 29, 2026). The charge is followed to its invoice and subscription;
    Stripe's collection for it is paused while the dispute is open, resumed if it is won, and
    the plan ends if it is lost, whichever order the dispute and the checkout arrive in.
    `test_billing_oct29.py` "a dispute pauses collection…", "a lost dispute pauses first…", "a
    dispute on an older plan's charge…", "a dispute that lands before the checkout…"
43. **A refund promised on deletion is recorded as paid only once it is paid** (October 29,
    2026). While a bank payment is clearing the amount stays due, the settle and the purge wait,
    and it is refunded against that payment when it arrives; a first payment still clearing
    (the plan never started) comes back whole, with no fee, and the Delete account screen says
    that same amount (owner decision, October 29, 2026). A payment that arrives for a deleted
    account grants nothing.
    `test_billing_oct29.py` "deleting while a yearly bank payment clears…", "a founding bank
    payment clearing at the deletion…", "a bank payment that fails after the deletion…", "a
    page paid after the deletion…"
54. **A household of two is one plan** (owner decision, October 29, 2026). While the holder's
    plan is live the partner is covered by it (`access.shared`): no trial clock, card ask,
    lockout or reminders of their own, nothing to buy. When it ends it ends for both, with the
    same notices and the same 7 days, and both close in one run; a dispute pauses both and closes
    neither. Whoever subscribes in the 7 days holds it for both. Leaving or deleting never ends
    the holder's plan; whoever it covered gets their own 7 days and an email. The holder may be
    either person: the owner covered by the partner's plan is covered exactly as the partner
    would be (October 29, 2026). One rule (`entitlements.household_plan`, invariant 67)
    answers it; the cover is read before a deletion ends any billing.
    `test_household_one_plan.py` · `test_household_matrix.py` · `household-plan.test.tsx` "an
    invite opens before any trial…"
55. **Shared jars travel soon** (October 29, 2026). A change to a shared jar, by any path, is
    published 2 s after the last change, not on the next 2-minute round; the app pulls on
    returning to the foreground and every 15 s while shared jars are on screen.
    `household-plan.test.tsx` "a deposit into a shared jar is published within seconds…",
    "pulls on coming back to the foreground…"
56. **An ended challenge is over** (October 29, 2026). Past its last day nobody new can look it
    up or join (409 `ended`), its screen says Ended with the final board and no deposit,
    check-in or invite, and its jar no longer holds a place on the plan. One helper on the
    device (`challengeEnded`) answers the cap, the jar's screen and the lists.
    `test_group_ended.py` (all five types) · `challenge-ended.test.tsx`
60. **A webhook that fails on our side is delivered again, and someone hears of it** (October
    29, 2026; a won dispute's closing event answered 400 when Stripe refused the first resume
    of collection, the plan stayed paused, nobody was told, and the same event sent again
    worked). Every webhook (Stripe, Apple, Google, Plaid) answers 400 only when the sender's
    request is wrong (a bad signature or payload, a purchase the store doesn't know); a failure
    on our side (Stripe or Play busy or down, billing not configured, a database error, a bug)
    answers 5xx with nothing of the attempt kept, the event id included, so the retry applies it
    in full. Each failure is logged with the event id, type and error code (Stripe's status and
    code, never its message); our own failures are also reported through `ops_alerts` as
    `<source>_webhook_failed`, while a refused request is logged only, never emailed (owner
    decision, October 29, 2026; `app/webhooks/failures.py`). Pausing or resuming collection is safe to repeat: a
    subscription already as asked, or ended, is done, not a failure.
    `test_webhook_failures.py`
61. **The refund on the Delete account screen says only what is true of it** (October 29,
    2026; a first bank payment still clearing showed $65.00 beside a fee line and "It's the
    credit on your account" while all $65 came back). `GET /api/billing/credit` carries
    `refund_kind` (`deletion.refund_preview`): clearing (all of it once the bank payment clears:
    no fee, no credit, no month kept), founding, unused (a yearly plan's months), credit (only
    the account's credit), mixed, none; the screen picks its lines from it and names a fee only
    when one comes off.
    `test_billing_oct29.py` "deleting while a yearly bank payment clears…", `test_billing_change.py`
    (yearly, monthly, Founding), `test_billing_hardening.py` (disputed) · `billing.test.tsx`
    "a first bank payment still clearing…", "a monthly plan's refund is its credit…",
    "Founding's refund…", "nothing to refund…"
67. **A household's plan has one rule, and what is shown is what applies** (October 29, 2026;
    the owner's test of #53 found four paths deciding it on their own). `household_plan`
    decides, for either person, who holds the plan, the state (subscribed, trial, paused,
    lapsed, ended) with its dates, and whether they are covered; `access`, `effective_plan`
    (so the limits, `require_feature`, `check_limit` and the shared jars' owner check),
    checkout's and the webhook's `purchase_conflict`, a plan change, joining, leaving,
    deletion and the plan job all ask it, and nothing else does. The limits applied are always
    the plan shown: a covered person who also pays for Private has the household's Connected,
    and an owner paying Private beside a partner paying Connected is covered by the partner's.
    There is one holder: a paid plan first (the owner's, then the partner's), else the owner's
    trial; the other is covered even when paying for a plan with household too, and is told
    they can stop it. The Leave sheet says what each person keeps from the same rule
    (`GET /api/household/leave/preview`, `leave_outcome`).
    `test_household_matrix.py` (holder owner / partner × 15 plan states, both people) ·
    `test_household_one_rule.py` "a covered person paying Private…", "an owner paying
    Private…" · `household-plan.test.tsx` "a holder whose plan ended…"
68. **Nobody is closed without the ended email for their end, nor during a dispute**
    (October 29, 2026; the owner covered by the partner's plan got their own old end back, so
    the next hourly run closed them with no email, and was never shown paused). Both people's
    end is the end of the plan that held the household after it became two, with the same 7
    days; a dispute on it pauses both; and the plan job closes an account only once the ended
    email for that same end has gone. A household that splits (a leave, a deletion, one
    closing alone) keeps what each member had (`household_split`, read before any billing ends):
    one lapsed with it keeps the same end and the same 7 days (never a fresh trial), one paused
    with it stays paused for that dispute (`users.household_paused_by`, migration 0040) until it
    closes, then has 7 days from the close. The 7 days are 7 × 24 hours in UTC (`grace_end`).
    When the holder loses a dispute, the one it covered gets
    "The plan that covered you has ended" (7 days, or download), never a word about the dispute.
    `test_household_one_rule.py` "the owner covered by the partner's plan…", "…disputed plan…",
    "after the holder loses a dispute…", "d1 …", "l6 …" · `test_household_matrix.py` "a split in
    the seven days…", "a split during a dispute…", "one closing alone…"
    · `test_household_matrix.py`
69. **Losing the cover while the holder's plan carries on starts one's own 7 days, with
    notice** (October 29, 2026; a holder switching down dropped the partner silently, with a
    fresh trial on offer). Leaving, deleting, and switching to a plan without household (in
    the app, at Stripe, or in a store) all go through `end_lost_cover`: the one no longer
    covered gets `household_cover_ended_at`, the "no longer covers you" email and 7 days,
    never a new trial; the change sheet tells the holder first, by the partner's name.
    `test_household_one_rule.py` "switching down gives the partner…" · `test_household_matrix.py`
    "switched_down"
70. **A household never pays twice** (October 29, 2026). While the household's plan covers a
    person, `purchase_conflict` answers `household_covered`: checkout refuses, and a page paid
    anyway (opened before joining) is ended at Stripe and refunded in full, once, with the plain
    email (invariant 41's path). Joining closes the joiner's open payment pages. Someone who
    pays for a renewing plan of their own is asked before joining whether to stop it at the end
    of its paid period (`you_pay`); nothing stops without their tap and the ticked "If you
    cancel" sheet, whose lines say the household's plan covers them next (owner decision,
    October 29, 2026).
    `test_household_one_rule.py` "a page paid after joining…", "the invite says when the joiner
    pays…", "a covered person stops their own plan…" · `household-plan.test.tsx` "asks before
    joining…", "Keep mine joins…", "the Plan screen says the household covers them…"

## Offline and the way in

35. **A call that never reaches the server is an answer, not a hang** (October 29, 2026). The
    API client turns a network failure into a status-0 response (`@stackd/api-client`), which
    `failureOf()` names `offline`; every pending state ends on it and a person-facing failure
    says "You're offline. Try again when connected." (`failureText`, `OFFLINE_MESSAGE`, the
    passkey ceremonies' `offline` error). Only a request its caller cancelled still throws.
    Found when Start trial with the network dropped stayed disabled for good.
    `api-client` `index.test.ts` "answers a network failure with status 0…" ·
    `offline-and-return.test.tsx` "Start trial with the network dropped…"
36. **The app opens with no network, locked, for the person last signed in here** (October 29,
    2026). A session check with no answer uses this device's last answer for a signed-in
    account (`lib/offlineSession.ts`), always locked; Unlock is a passkey check on the device
    alone (user verification, only the passkeys that unlocked this account here) and opens
    only what is stored on the device; the server session is untouched and is asked again on
    `online`. A drop later in a run keeps the server's last answer. Sign-out and a server
    "no session" forget it; Log out offline signs out on the server at the next open online.
    Found when the app opened offline stayed on a blank screen.
    `offline-and-return.test.tsx` invariant 36 · `e2e/offline.spec.ts`
37. **Signing in ends where the link that started it pointed** (October 29, 2026). A path
    opened signed out (query and `#k=` fragment too) is kept in this tab's `sessionStorage`
    through Welcome, the email code or a passkey, passkey setup and the trial pick, then taken
    once (`lib/returnTo.ts`: only a path of this app, never a sign-in screen or another
    origin); the household key is never put in a query string or a request. Found when a
    challenge link landed on Home after sign-up.
    `offline-and-return.test.tsx` invariant 37 · `e2e/offline.spec.ts`
57. **A closed account is never offered a sign-in that can't work** (October 29, 2026). The
    server reports a closure once; the device's own record (`qash.kept_account`) carries it
    after that. The closure forgets the remembered account (`stackd.last_account`); while the
    record exists, every signed-out open of the app leads to `/kept` (download, erase, start
    again), Welcome shows "Your account closed on <date>. Your data is still on this device."
    in place of the passkey buttons, and no passkey message says "no passkey" for it. A second
    report of the same closure keeps the first date. Found when the second open after a
    closure offered "Continue with Touch ID" and then said "No Qash passkey on this device".
    `kept-and-storage.test.tsx` invariant 57 · `e2e/kept.spec.ts`
58. **A browser that may erase this device's data says so before it does** (October 29,
    2026). In an iPhone browser tab (not the Home Screen app, not a native shell) Home shows
    "Keep your data safe" from day 1 until the person adds the app to the Home Screen, turns on
    backup or downloads a copy (good for 30 days); elsewhere the export reminder
    (`shouldNudgeExport`) shows where the browser hasn't promised to keep the data and there
    is no backup. "Not now" quiets it for 3 days, but a gap of 5 days since the last open
    always shows it (`data/persist.ts` `storageRisk`). Found when an iPhone tab user could
    lose everything after 7 days unused with nothing said.
    `kept-and-storage.test.tsx` invariant 58
59. **A device transaction awaits only the database** (October 29, 2026). Inside
    `db.transaction(...)` nothing awaits the engine, the network, crypto or a timer: the
    worker answers in a later task, IndexedDB commits the transaction meanwhile, and the next
    write fails with "Transaction has already completed". Work out what needs the engine first,
    then write in one transaction. Found when "rename every entry like this" asked the engine
    for merchant keys inside its transaction.
    `transaction-scope.test.ts` (the engine answering a task later, as the worker does)

## What the screens say

63. **Turning push on always ends in words** (October 29, 2026). Every way the browser, the
    push service, the native shell or the network can refuse is an outcome of
    `subscribeToPush` (`blocked`, `denied`, `dismissed`, `push_failed`, `offline`,
    `not_saved`, `unsupported`, `unavailable`, `needs_home_screen`), never a throw or a wait
    without end (the service worker, the push service and the server each get 15 seconds; the browser's permission question has no limit, owner decision October 29, 2026); the "Stay on track"
    sheet says what happened and what to try (`pushOutcomeText`), offers Try again only where
    another tap can help, and never leaves a disabled button. Found when a Chrome private
    window refused push and the sheet stayed open saying nothing.
    `notifications.test.tsx` invariant 63 · `native-features.test.tsx` invariant 63
64. **A balance says where it came from** (October 29, 2026). One helper
    (`linking/anchorText.ts`) names a balance's source everywhere: a statement's date, the bank
    and when it last synced ("from First Platypus Bank · synced 5 min ago"), or "you entered".
    A linked account is never "you entered", "Manual balance" or "Never imported". Found on
    Accounts & imports and Next 30 days' "How we calculated this".
    `settings-data.test.tsx` invariant 64 · `forecast.test.tsx` invariant 64
65. **A linked card is a debt in the plan, counted once** (October 29, 2026). The payoff plan
    and everything built on it (Home's Debt-free card, What if, the month review, the balance
    comparison) read one list, `debtPlan.readPlanDebts`: hand-added debts plus each linked
    card at the bank's balance with the issuer's APR and minimum, or the person's own when the
    issuer sent none (asked once). A hand-added debt the person paired with a linked card is
    that card (one row, the bank's balance), and net worth leaves it out beside the account.
    Found when Debt payoff showed linked cards on top and "No cards or loans yet" below.
    A card's rate typed by hand is 0% to 40%; any other debt's 0% to 400%, asked once above 40% (`bills/apr.ts`). `debt-linked-cards.test.tsx`
66. **A count says only what changed, or what is still to do** (October 29, 2026). A linked
    sync counts a row as updated only when it differs from what is stored (a row sent again
    as it is is not written at all), a pending row posting is one update, and split parts and
    partners moved with a row are not counted (`sync.sameRow`); "Up to date." when nothing
    changed, else "3 new · 1 updated". Home's "Found in your statements" counts the paycheck
    only while it is still offered (Budget has no pay yet). Found as "Up to date: 170 updated"
    with nothing changed, and "1 paycheck" after pay was set.
    `linked-sync.test.tsx` invariant 66 · `home-visual.test.tsx` "once Budget has pay…"

59 (again, October 29, 2026). The sweep was repeated on main after #51: every
`db.transaction(...)` body in `apps/web/src` (47) was read for awaits of anything but Dexie,
including the linking sync write, the import commit, the backup merge, the household pull and
split, goals, milestones, receipts, categories, budgets and settings writes, and no
`useLiveQuery` callback writes. None was found. `transaction-scope.test.ts` now fails on any
transaction body that awaits something other than the database or a helper read and listed as
Dexie-only, and runs a linked sync page with the engine answering a task later.

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
