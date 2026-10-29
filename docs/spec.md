# Stackd — PWA Design & Build Spec (for Claude Code)

Exported October 9, 2026 (spec rev 142).

## Overview

Stackd is a mobile-first PWA that helps people keep more of what they earn: budget, build an emergency fund, cut waste, and hit savings goals through solo and group challenges. Version 1 launches as an installable PWA; native iOS/Android wrappers come later using the same codebase and the same settings requirements.

**Product name:** "Stackd" is a placeholder until branding is confirmed.

**Goals for v1**

- Users see money in, money out and what they kept each month — from uploaded statements or manual entries — plus upcoming expenses and an early warning if they may run short. Users set a budget (50/30/20 or zero-based) and see where they stand in under 5 seconds.
- Users create goals (savings jars, card payoff, spend-less, habits) with one sentence-style form.
- Users join or create group challenges with a fair, privacy-safe leaderboard.
- Users log spending manually or by uploading a receipt photo.
- Users choose light or dark, an optional Simple layout, and a look: six on the web (Modern, Minimal, Retro 80s, Pastel, Anime, Illustrative), three in the native apps (Modern, Pastel, Anime).

**Non-goals for v1**

- No brokerage or investment linking. Bank and card linking is read-only, on Connected only, through Plaid (see Security); Free and Private never link.
- No AI or LLM API calls of any kind at runtime.
- No live savings-rate offers, partner feeds or product recommendations. Nothing is cancelled for the person: the Subscriptions view shows what each one costs a year and how to cancel it, and the person does the cancelling.
- No money movement; savings jars are virtual labels on money the user says they set aside.

**Decisions locked**

| Decision | Choice |
|---|---|
| Platform | PWA first, native wrappers later |
| Build tool | Claude Code (development time only) |
| Runtime analysis | Python, rule-based and deterministic |
| Looks | PWA: Modern (default), Minimal, Retro 80s, Pastel, Anime, Illustrative · Native apps: Modern (default), Pastel, Anime |
| Decluttering | Simple layout switch, works with every look |
| Dark mode | Every look, plus Match system |
| Data input | Manual entry, statement upload, receipt photos — stored on the device |
| Savings accounts / HSA content | Static explainer only; offers deferred |

Design reference: the **FINAL — Modern · Pastel · Anime** page of the mockup canvas, also included as HTML files in the handoff ZIP. Approved screens: Home in each look, Home with Simple layout, Settings in each look (with the delete-account dialog), Add receipt and Goal builder. Every other screen is built from this spec using the same tokens and components.

## Launch scope — frozen October 9, 2026

**Change rule:** nothing enters the launch scope unless something of equal size leaves it, with written sign-off from [owner]. New ideas go to the parking lot, not the backlog.

**In the PWA launch (Modern look only)**

- Sign-up: email code + mandatory passkey, 5-minute lock, step-up checks, always-on security alerts.
- Onboarding: pay, budget style, data source, first jar, plan picker, keep-data-safe checklist.
- Money in & out, budget (50/30/20 and zero-based), manual entries, receipts kept on the device.
- Statement import: **CSV and OFX/QFX only**, parsed on the device.
- Upcoming expenses, 30-day forecast, shortfall warning.
- Jars and goals: **basic custom jars** (own name, amount, date) plus the 4 goal kinds.
- Groups: **one challenge type** — a monthly savings challenge: each member saves their own target this month, ranked by %; runs the 1st to month-end and can repeat monthly or be done solo.
- Notifications with user controls; Insights (summary cards that open the detail screens) and the growth calculator. *Scope change, owner decision October 18, 2026: the Learn articles are removed (they read too close to advice); Insights replaces the Learn tab.*
- Couples / household with shared jars and goals, on encrypted sync across devices (Connected and Founding members). Settings, data export, account deletion; **encrypted ****backup and sync** for paid plans. Swapped out to make room: the debt payoff planner and the standalone emergency-fund screen (the emergency fund is a jar with runway shown).
- Plans: Free, Private (statements read on the device; never links), Connected (read-only bank and card linking through Plaid, plus couples), and the Founding member offer.
- Read-only bank and card linking (Phase 3) for Connected: every analysis, chart, nudge and push works on linked data the same way it does on statements. *Owner decision, October 12, 2026.*
- Layout: phone-first, **responsive single column** on tablet and desktop.
- Website: landing, how it works, pricing, security, privacy, terms, delete account, support.

**Fast-follows, in this order**

1. Debt payoff planner (avalanche) and the standalone emergency-fund screen. *Built October 10, 2026: `bills.payoff_plan` with the extra per month stored on the device (`settings` `debt.extra_cents`; suggestions $0 / $50 / $100 / $200 or any amount, owner sign-off, October 27, 2026), the Payoff plan card on Bills → Debt payoff, and `/emergency` reached from Home's starter-fund and runway cards.*
2. PDF statement templates for a launch list of banks. *Built October 10, 2026: PDFs are read on the device from their text layer (pdf.js through `unpdf`), `importers/pdf/templates.ts` holds per-institution templates tried before the generic "date, description, amount, [balance]" layout (sign from the running balance when there is one), `statement_imports.template_key` records which read the file, scanned images and unknown layouts get the "download a CSV or OFX instead" message. The launch bank list (`[launch bank list]`) is still an owner decision: each bank's template comes with a fixture, never a guessed layout.*
3. Custom-goal extras: milestones, ongoing goals, saved templates, priority, jar split. *Built October 10, 2026: `goals_custom.plan` (cadence, per-period amount, finish date, next deposit date), `goals_custom.streak` (ongoing goals with pauses), `goals_custom.milestones`, `withdrawal` events for moving money between jars, `goal_behind_pace` in the next-move order, the why line, pause / resume, priority order and local templates. Sharing a template to a group as a challenge waits for fast-follow 4 (more challenge types).*
4. More group challenge types (habits, spend-less). *Built October 10, 2026: No-Eat-Out Week (a seven-day habit), Dining diet (spend less on dining this month, each member with their own usual spend and amount to keep back), No-spend weekend (a two-day habit from a Saturday) and 52-week saving (own total over 52 weeks, weekly cadence; $1,378 is the classic default; any total, or "step up by $X each week" for 1,378 × X, owner sign-off, October 27, 2026). `groups.template_key` takes the five keys (migration 0008); week, weekend and year challenges start on a date the creator picks (today to 31 days ahead, owner sign-off, October 27, 2026); the ranking stays % of each member's own target, with habits ranked by days checked in and the diet by the share kept back. Sharing a saved goal template to a group remains open: the five templates are fixed.*
5. Desktop two-pane layout. *Built October 10, 2026: from 900px the main column widens and `.two-pane` puts a main pane and a side pane side by side (one column below 900px and in Simple layout); Home becomes the dashboard of the PWA · Desktop mockup (date, "Good morning, [Name]", the numbers on the left, recent entries on the right) and Goals shows jars and challenges together with no tab switch; the side rail shows who is signed in. Other screens keep the single wide column.*
6. Receipt text reading (OCR) and the weekly recap email. *Built October 10, 2026: the weekly recap is a screen (`/recap`, "Your week": the seven days ending today as Got · Spent · Kept from `cashflow.period_totals`, the change against the week before, where it went, jar deposits, a link to the next 30 days) that the push and a new email open; the email is scheduled server-side from the preference (`jobs/weekly_recap.py`; `notification_prefs.channel` push / email / both, migration 0009; the device's `recap:<date>` key, so nothing doubles up) and carries a link and no numbers. "Read text from photo" runs Tesseract.js on the device from files the app serves itself (no CDN, no upload; the English model is pinned in package.json), keeps the text and the engine version on the receipt row, and shows the merchant, date and total it found for review; only "Use these" fills the form. The OCR open question below stays open: a "no" means deleting `features/receipts/ocr/` and the button.*

**Later phases:** Phase 2 native apps in the stores (three looks). Phase 3 (read-only bank and card linking) is part of launch, not a later phase (Owner decision, October 12, 2026).

**Parking lot (not scheduled):** investments beyond a net-worth value, more looks, more languages. **Never:** AI features (owner, October 19, 2026: "No AI ever"), subscription cancellation or bill negotiation done for the user, credit reports or scores, moving money.

**Onboarding (owner decisions, October 20, 2026).** Choices, not a wizard: after the trial pick (which states up front how the trial works: no card, the reminder the day before (2 days before October 22, 2026), the 7 days with a note each day, the account closing, the data staying on the phone), `/setup` "Make Qash yours" lists six optional steps the person takes in any order or skips, each marked done from the data itself so it reads the same wherever it was done; Home's "Make Qash yours · n of 6" card shows the next three until all are done or the person says "Done for now". No onboarding analytics: nothing is counted or sent (we promise no trackers); trial → paid is already known from billing.

**Trial and plan ends (owner decisions, October 20, 2026).** The 7 days after a trial or plan ends without a new one stay, with a friendly note every day (email, and a push with fixed words to devices that allowed alerts); the wording is an update, not a warning. When the account then closes, the server deletes what it kept as before, but tells each device the account closed because its plan ended (`deleted_reason: plan_ended`, migration 0027), and the device **keeps its data until the person decides**: `/kept` ("Your data is safe here": Download my data, built on the device with no server; Start again; Erase it from this phone). Signing up again with the same email on that device offers to bring the data into the new account (matched by a hash of the email kept on the device while signed in; never offered to anyone else). A deletion the person asked for still erases the device at once. The trial picker states all of this before the trial starts.

**Added to scope, owner sign-off October 19, 2026 (after reviewing Rocket Money's Premium):** in this order, (1) **net worth** on Insights with its own screen (below, "Net worth"); (2) **tags and notes on entries**; (3) a **customizable Home** where the person drags the cards they care about into their own order and hides the rest (built: "Customize Home" under the cards; low-balance warnings can't be hidden); since October 25, 2026 every main screen works the same way, owner decision: "Customize Insights", "Customize Next 30 days", "Customize Later" and, on Money in & out's month view, "Customize Money in & out", each saved as `settings` `<screen>.layout` and synced like Home's). Then, also signed off the same day (after comparing Rocket Money's Premium list line by line), in this order: (4) **custom categories** (the person's own, alongside the fixed list); (5) ~~a monthly In vs Out chart (the last 6 months)~~ replaced the next day by **time ranges** (owner sign-off, October 20, 2026; below, "Time ranges"): Money in & out, Where it went and Net worth each get a 1M · 3M · 6M · 1Y · All picker like a stock chart's, with the change against the period before; (6) **largest purchases and most frequent merchants** on Insights (built October 20, 2026: `/insights/spending` with the time-range chips, the biggest single amounts out and the merchants paid most often, each opening its entries); (7) **swipe to rename or hide** an entry, built October 20, 2026 as **Rename** and **Don't count** (owner decision the same day, after weighing what people mean by "hide"): swipe left on any entry (or use the editor's "Count in my spending" switch and name field). A not-counted entry leaves every spending total (In / Out / Kept, budgets, categories, insights, the recap, typical spending, spend-less goals, the household summary) but stays in balances and net worth, because the money moved; it stays listed, faded and tagged "Not counted", with a "Not counted (n)" filter on Money in & out and an Undo toast. Rename can rename every entry with the same bank text and keeps that name for future statements and bank updates (`merchant_names`; a name the person gave is never overwritten by a sync; listed and removable under Accounts & imports). When another entry has the same date, amount and direction, the swipe offers "Duplicate?", which opens the entry with a note so a double import is deleted rather than hidden; (8) a **calendar view** of bills and paydays on Next 30 days (built October 20, 2026: a List / Calendar switch on Upcoming, remembered on the device; a green dot per payday and a red one per bill, faded once paid, days the estimate puts under the cushion tinted red, today outlined; tapping a day shows what's due and about how much is left that day); (9) a **category review** screen that steps through what isn't sorted yet (built October 20, 2026: "Sort your spending" at `/review`, from Insights' Auto-sorted card when anything is unsorted and from Money in & out: one entry at a time, newest first, money in offered money-in categories; nothing is pre-picked or suggested (no AI in the code, owner decision October 28, 2026), the person picks; "Do the same for all N like this" (on when there are others with the same bank text) sorts them together and saves a category rule for future imports, and also applies "It's a transfer" or "Don't count" to them; Skip for now; Undo puts every entry back and forgets the rule). Every one is plain arithmetic or sorting by fixed rules: no AI, no credit score, no negotiation or cancellation done for the person. Built (owner decision, October 27, 2026, the owner's word bringing it into launch scope): a **Subscriptions view** (below, "Subscriptions"). Still to name: "Glances" as the name for the native apps' home-screen widgets.

**Parking lot, added October 10, 2026 (from a user interview: paid every 15 days, all spending on a credit card paid off most months, two car loans, a mortgage, a strong credit score and almost no savings).** Each needs `[owner]` sign-off and an equal-size swap before it enters launch scope; everything here is education and arithmetic on data the user types in, never advice and never bank data.

- *Card utilisation line.* The user enters a card's credit limit on the account; the app shows statement balance ÷ limit as a percentage with a one-line explainer of why lenders look at it. Pure rule (`credit.utilization_bps`, owner sign-off, October 27, 2026), no bureau data.
- *Pay-in-full by payday.* A pay-off goal with the "on payday" cadence (already fast-follow 3) that splits the statement balance across the pay dates before the due date, so a card paid "mostly" each month becomes paid in full on a schedule. Uses the existing payday schedule rules.
- *Learn articles (1.10 candidates; dropped October 18, 2026 with the articles):* "A great score with no savings is still one surprise away", "Statement date, due date and interest: what paying in full means", "Two loans at once: the avalanche order explained" (the avalanche rule exists for fast-follow 1), "Paying a mortgage every two weeks: what the extra payment does" with a calculator labelled as an illustration, like the compound-growth one.
- *Already covered at launch:* every-15-days pay (payday schedules in `dates.py`, take-home in 1.4), the $1K starter fund as the first next move (1.8), car loans and the mortgage as confirmed bills feeding Upcoming and the forecast (1.7, 1.10), savings jars and the monthly challenge (1.5, 1.6).

**Launch metrics:** share of new users who import a statement or add 10 entries in week 1; week-4 return rate; Free → paid conversion; Founding member sales.

## Hard constraints

These are non-negotiable. A pull request that breaks one must fail CI.

1. **Deterministic.** The same inputs and the same rule version always produce the same outputs. No randomness in calculations, no time-dependent logic except an explicit `as_of` date passed in.
2. **No AI APIs.** No calls to any LLM, AI or ML-as-a-service endpoint, from client or server. Enforce with a dependency denylist (e.g. `openai`, `anthropic`, `google-generativeai`, `langchain`, `cohere` and similar) and an outbound network allowlist on the backend. No learned or statistical models in the code either, except the receipt text recognition below. *Owner decision, October 28, 2026: no AI in the code at all. The bundled category model allowed as an exception on October 11, 2026 is removed (`categorize.suggest`, its corpus, training script and weights, RULES_VERSION 0.34.0); entries are sorted by the person's own rules and the hand-edited keyword table only, and anything neither matches stays uncategorized for the person to sort, never guessed. The denylist and allowlist are unchanged. No model ever judges, guesses or decides anything about the person's money. One exception, owner decision October 28, 2026: on-device text recognition for receipt photos (Tesseract, fast-follow 6), which only reads letters from a photo the person chooses, runs only when they tap "Read text from photo", is served from the app's own files and never leaves the device; its suggestion is shown for review and fills nothing until "Use these". It is deterministic for a given device and pinned engine version (`ocr_engine_version` is stored with the text).*
3. **Read-only linking only, and only on Connected.** Data enters by manual entry, statement upload, receipt photo, or (Connected) read-only bank and card linking through Plaid, which follows the Bank linking rules in Security: never bank passwords, never money movement. *Owner decision, October 12, 2026: Phase 3 linking ships before go-live; the launch gate includes it. Free and Private never link.*
4. **PWA first.** Installable, works offline for viewing and logging, syncs when online. Code must not assume a native shell.
5. **Store-ready from day one.** In-app account deletion, a web deletion path, full data export, privacy policy and terms links. Store policies change, so re-verify against Apple and Google rules at submission time.
6. **Plain language.** No financial jargon without a one-line explanation. Nothing in the app is presented as financial advice; educational content carries a short disclaimer.

**Local-first.** Statement files, receipt photos and transactions live only on the user's device. The server never stores them in readable form (see Architecture → Data flow).

**Receipt text reading (OCR) note.** The optional "Read text from photo" feature uses open-source OCR (Tesseract) running on our server or on the device. It calls no external AI service and is deterministic for a given image and engine version. It does use a trained model internally. If the team decides "no machine learning at all", ship receipts as manual entry with the photo attached and remove this button.

## Architecture & stack

A TypeScript PWA talks to a Python API; all money math lives in one versioned Python rules package. The stack below is a recommendation; Claude Code may substitute equivalents if it records why.

| Layer | Recommendation | Notes |
|---|---|---|
| Frontend | React + TypeScript + Vite, `vite-plugin-pwa` | Service worker, offline cache, install prompt |
| Native later | Capacitor wrapping the same build | Keeps one codebase for iOS/Android |
| Styling | CSS custom properties driven by theme tokens | No per-look component forks |
| Local storage | IndexedDB (e.g. Dexie) | Offline queue of entries and receipts |
| Backend | Python 3.12 + FastAPI | Stateless API |
| Rules engine | `stackd_rules` Python package | Pure functions, versioned; runs on the device |
| Data analysis | pandas / plain Python | Inside the rules package only |
| Database | PostgreSQL | Account, plan, groups, alert schedule, backup index only |
| File storage | S3-compatible object storage | Encrypted backup blobs only (ciphertext); never statements or receipts |
| OCR (optional) | Tesseract`.js (WebAssembly)` | On the device; see Hard constraints |
| Auth | Email + one-time code, passkeys (WebAuthn) | No passwords in v1 |
| Email | Transactional provider | OTP codes, export links, weekly recap |

**Data flow**

1. The user types an entry, uploads a statement or adds a receipt photo. Files are read in the browser and **never sent to our servers**.
2. Parsed rows are stored in IndexedDB on the device; the device copy is the user's copy.
3. The rules engine runs on the device in a Web Worker: the same `stackd_rules` Python package via Pyodide (WebAssembly), or a TypeScript port that must pass the identical golden tests. Chunk 0.6 decides after a prototype (download size, speed on a mid-range phone) — decision due by the end of build week 1.
4. Results render from device storage and carry the `rules_version` that produced them.
5. The server receives only: account and passkeys, plan, group % progress, a minimal alert schedule (date, type, generic label — no amounts or merchants), and, when enabled, an end-to-end encrypted backup it cannot read.
6. Connected plan: bank data passes through the server to the device and is not stored; the server keeps only the encrypted bank token.

**Device storage can be lost.** Browsers may clear site data; Safari can erase script-written storage for sites not used for seven days, while Home Screen web apps keep their own usage counter. Mitigations: prompt Home Screen install, request `navigator.storage.persist()`, remind Free users to export, and offer the encrypted backup on paid plans.

**Proving determinism**

- Every rule function has golden-file tests: fixed input JSON → exact expected output JSON.
- Store `rules_version` on every computed result so past numbers can be reproduced.
- Money is integer cents everywhere; rounding is half-even, done once at display.
- CI fails on: denylisted AI packages, outbound calls to non-allowlisted hosts, golden-test drift.

## Theme system

Six looks × light/dark = twelve combinations, all from one token set. Modern is the default for new users; Match system is on by default. The user's choice is saved on the device and on their account.

**Looks by platform** (Owner decision, October 12, 2026, replacing "PWA: Modern only"). The PWA offers **all six looks**: Modern, Minimal, Retro 80s, Pastel, Anime and Illustrative. The native iOS and Android apps offer **Modern, Pastel and Anime** (`NATIVE_LOOKS`). One codebase: `availableLooks` is all six on the web and three natively. Each look's fonts load only when it is picked and are cached on first use, so the install stays small and a chosen look works offline.

- The user's look is saved on their account from either platform (Settings → App look, a tile per look drawn in that look).
- A look the platform doesn't offer shows Modern there and the saved value is left alone: pick Retro 80s on the web, open the iPhone app (Modern), return to the web (still Retro 80s).
- **Looks change colours, type, corners, borders and one decorative texture, never layout, wording or controls.** Every look × mode pair passes the CI contrast check.
- **Human, not generated.** Spot illustrations in empty states are hand-drawn (uneven ink lines, a flat colour wash printed slightly off the line, no gradients or gloss) and drawn in the current look's colours; Illustrative adds paper grain and ink outlines, Retro 80s a sunset grid on the hero card, Anime halftone dots. Avoid the generic generated look: no purple-blue gradients everywhere, no glass, one strong idea per look, warm surfaces, short plain sentences.

**Settings exposed to users**

- `look`: `modern` (default) · `minimal` · `retro` · `pastel` · `anime` · `illustrative`
- `mode`: `light` · `dark`, or follow system
- `simple_layout`: off by default; works with every look

**Shape and type tokens**

| Token | Modern | Pastel | Anime |
|---|---|---|---|
| Display font | Outfit 600–700 | Sora 700–800 | Dela Gothic One |
| Body font | Outfit 400–600 | Plus Jakarta Sans 500–800 | M PLUS Rounded 1c 500–800 |
| Hero number font | Outfit 700 | Sora 800 | DotGothic16 (hero only) |
| Data/input number font | Outfit, tabular figures | Sora, tabular | M PLUS Rounded 1c, tabular |
| Card radius | 22px | 26px | 14px |
| Border | none | none | 3px solid ink |
| Shadow | 0 6px 20px rgba(17,24,39,0.08) | none | 0 5px 0 ink (hard) |
| Toggle shape | pill | pill | rounded square (8px) |
| Decoration | none | none | halftone dots, speed lines |

**Light mode colors**

| Token | Modern | Pastel | Anime |
|---|---|---|---|
| bg | #F4F5F8 | #EEF0F4 | #FDF1DC |
| card | #FFFFFF | #FFFFFF | #FFFFFF |
| ink (text) | #111827 | #16161D | #1B1E4B |
| sub (secondary text) | #5B6272 | #5C5C6B | #55597F |
| line | #E4E7EE | #DCDEE5 | #E7DCC6 |
| accent-1 (hero) | #3D5AFE | #D9D2FF | #FFC531 |
| accent-2 | #0B7A55 | #C9F2DE | #00B8D9 |
| accent-3 | #7C3AED | #FFD9C2 | #FF3E7F |
| on-accent text | #FFFFFF | #16161D | #1B1E4B |

**Dark mode colors** (accents and on-accent text stay the same as light)

| Token | Modern | Pastel | Anime |
|---|---|---|---|
| bg | #0B0D12 | #0F0F14 | #14163A |
| card | #151821 | #1B1B23 | #22265A |
| ink | #F1F3F8 | #F3F3F7 | #FDF1DC |
| sub | #9AA1B2 | #A6A6B5 | #C3C5E2 |
| line | #262A36 | #33333D | #3A3F7A |

**Semantic colors (fixed across all looks; owner sign-off, October 27, 2026; contrast checked in CI)**

| Meaning | Light | Dark |
|---|---|---|
| success / good | #1E7A4C | #6FD39B |
| danger / delete | #C4122F | #FF6B7D |
| warning | #A85A00 | #FFB547 |

**Simple layout** keeps the look's colors and fonts but: tile grids become plain lists, decorations (halftone, speed lines, stickers) are hidden, and each screen shows its single most important number plus a list. Every screen must be designed in both full and simple layouts.

Font loading: load only the active look's fonts, subset by Unicode range, `font-display: swap`. The PWA loads only Outfit; the native apps bundle every look's fonts inside the app, so there is no download cost.

## Theme rules

Looks change appearance only. Breaking any rule below is a bug.

1. **Same layout in every look.** Navigation, screen structure, button positions and icon meanings never change between looks. Components read tokens; there are no look-specific component forks.
2. **Same wording in every look.** Standard labels ("Challenge", "Progress") appear in all looks. Anime flavor text ("Boss battle", "EXP", Japanese accents like 貯金) is decorative and sits beside the standard label, never replacing it. Simple layout hides flavor text.
3. **Semantic colors are locked.** Success, danger and warning use the fixed semantic tokens. An accent color must never signal an error or a destructive action.
4. **Readable money.** The pixel font is allowed only for the large hero number in Anime. Inputs, lists, tables and receipts use the body font with tabular figures.
5. **Contrast.** Body text ≥ 4.5:1 and large text ≥ 3:1 (WCAG AA) in all six combinations. Run an automated contrast check over the token tables in CI.
6. **Touch targets.** Every interactive element ≥ 44×44 px in every look.
7. **Theme switch is instant.** Changing look or mode re-renders without reload and without losing unsaved input.
8. **Motion.** Respect `prefers-reduced-motion`; Anime decorations are static when it is set.

## Navigation & screens

A five-tab bottom bar: **Home · Budget · Goals · Insights · Me**. "Insights" replaces "Learn" (owner decision, October 18, 2026), which replaced the earlier "Grow" tab.

| Screen | Tab | Purpose | Mockup |
|---|---|---|---|
| Welcome & sign-in | — | Email entry, then 6-digit code | Build from spec |
| OTP entry | — | Code input, resend timer, paste support | Build from spec |
| Onboarding | — | "Make Qash yours" (`/setup`, owner decisions October 20, 2026): six optional steps in any order, each done when the thing exists: add your money (statement, link, or by hand), your pay, budget your way (50/30/20 suggested, your own split, or zero-based), a jar of your own, keep your data safe (encrypted backup + recovery key), arrange your Home; "Done for now" anytime; shown after the trial pick and as Home's card until done; nothing measured or sent | Built |
| Home | Home | Got · Spent · Kept with a one-line verdict and In (green) / Out (red) bars (the spend meter was removed, owner, October 19, 2026), Set aside this month against the save target, next move (shortfall first), budget status, runway, active challenge | Home (each look) + Simple layout |
| Budget | Budget | 50/30/20 or zero-based, category progress | Build from spec |
| Add entry / receipt | Global + button | Manual entry or receipt photo | Add receipt |
| Goals list | Goals | Active goals and jars, progress, add button | Build from spec |
| Goal builder | Goals | Sentence-style creation and templates | Goal builder |
| Challenge detail | Goals | Progress, check-ins, group leaderboard | Build from spec |
| Emergency fund | Home → card | Emergency jar with runway at launch; standalone screen is fast-follow 1 | Build from spec |
| Bills & debt | Home → card | Bills list and bill tips; debt planner is fast-follow 1 | Build from spec |
| Insights | Insights | Summary cards (money in & out, auto-sorted spending, bills & subscriptions, safe to spend, budget & jars, net worth) that open their detail; Later (the savings projection) | Build from spec |
| Settings | Me | Everything in the Settings spec | Settings (each look) |
| Delete account | Me | Confirmation dialog | Settings → Delete account |

**Day-1 screens added:** Money in & out (month view, reached from Home's summary card and the top of Budget), Import statement (from the + button: upload, account, column mapping, preview), and Upcoming & forecast (Home card → 30-day list and balance chart); Passkey setup (sign-up), Lock screen (auto-lock), Step-up check sheet, Manage passkeys, and Accounts & imports manager (Settings). Mockups to design.

"Build from spec" screens reuse the approved components: themed cards, list rows, toggles, progress bars, the tab bar and the sentence builder.

### PWA-only screens and states (Modern)

| Screen / state | When it shows | Mockup |
|---|---|---|
| Install guide — iPhone | Safari on iOS, not yet installed; after 2nd visit or from Settings | PWA · Install (iPhone) |
| Install card — Android/desktop | `beforeinstallprompt` fired; after 2nd visit or from Settings | PWA · Install (Android) |
| Install page `/install` (owner decision, October 19, 2026) | The website's "Install the app" button (shown before launch too); no sign-in. iPhone Safari: picture steps (Share → Add to Home Screen → Add → open) with an arrow at Share; other iPhone browsers: "Open in Safari" + Copy link; Android and computers: one-tap install when the browser offers it, else the menu steps; already installed: "You're all set" | none (drawn steps) |
| Notification pre-prompt | Before the browser permission dialog; iOS only after install | PWA · Notifications |
| Offline banner + pending sync | No connection; entries saved locally | PWA · Offline |
| Update available | New service worker waiting | PWA · Update |
| Launch screen + app icon | App start from home screen | PWA · Launch screen, PWA · App icon |
| Desktop / tablet layout | Viewport ≥ 900px: side rail; below 900px: the bottom tab bar, single column (owner feedback, October 12, 2026: a rail at 600–899px left too little room) | PWA · Desktop |
| Settings (PWA) | Me tab on web | PWA · Settings |

Rules: never show the install guide inside the installed app (`display-mode: standalone`); a dismissed install prompt stays hidden for 14 days (owner sign-off, October 27, 2026); queued entries sync automatically when back online, oldest first.

## Feature specs

### Budgeting

- User enters monthly take-home pay (manual).
- **Your pay (October 28, 2026; "Suggest, then take their own value").** The screen leads with one word and the monthly figure ("Monthly · $5,200.00 a month", "After tax. Stays on this phone."), then the paycheck, how often, and when: weekly and every 2 weeks suggest a next payday (the paycheck found in the person's statements, else the next Friday) or take any date from today; **twice a month** asks for the two days (1st & 15th or 15th & last day in one tap, or any two of 1st–31st and Last day); **monthly** for the day (1st, 15th, Last day, or any day). "Next paydays" shows the next three from the engine before Continue. Saved as `pay.days` (31 = the last day); pay saved before keeps its old reading (`next_payday`, and for twice a month that day and 15 days from it). One reading for every screen: `features/budget/payDays.ts`.
- Two methods, switchable: **50/30/20** (needs / wants / save + pay down) and **zero-based** (every dollar assigned until "left to assign" = $0).
- **A budget alert in the moment (October 28, 2026; proposed, awaiting owner sign-off).** When a category's spending this month reaches a level of its plan, the app says so on Budget and, if the person allows it, with one push: "Close" on the line at 90% of plan or more, "Over" once spent passes the plan. Zero-based budgets are checked per category line with something planned; the bucket method (50/30/20 or the person's own split) has no category plans, so it is checked per bucket. The save bucket and save categories are never checked: putting more aside is not overspending. The levels come from `config/insights.yaml` `budget_alerts.levels_bps` (proposed: 9000 and 10000). In Alerts, **Budget alert** is on by default (proposed) with "Tell me at": 90% or 100% as suggestions, or the person's own whole percent from 50% to 150% (proposed); a level under 100% also alerts at 100%. Budget's "Close" uses the same level: the person's own "Tell me at" when set, else the config's first level, so the screen and the push never disagree. Alerts describes it as "a budget line" (a category on zero-based, a bucket on 50/30/20). Each level alerts at most once per category per month, at the person's alert time that day (09:00 unless chosen), or at once if that time has passed. The push is generic ("A budget line is close to its plan. Open Qash to see which." / "A budget line has reached its plan."): the key the server stores names the month, a tag and the level, never a category, its name or an amount (the tag is FNV-1a over a random value kept on the device and the category's id, so the server cannot work back from it).
- **Zero-based, complete (October 23, 2026).** Left to assign (from `budget.summary`) with **Assign what's left** (the rest into one category) and, on a fresh plan, **Start from last month** (each line with nothing planned takes what was spent in its category last month); each line shows spent of planned, what's left or over, and a bar; an over line has **Cover it**, and **Move money** moves planned amounts between lines (never below zero on the line it leaves; it never changes what's left to assign); a line with nothing planned says "nothing planned yet", never "over"; lines with nothing planned or spent fold into one row; Undo on each move. Home's Budget tile says "$X left to assign", "$X over-assigned", "N categories over plan" or "Every dollar has a job".
- Spending comes from manual entries and receipts, each tagged with a category that maps to a bucket.
- Default categories: Rent, Groceries, Utilities & phone, Transport, Insurance, Dining, Shopping, Subscriptions, Fun, Savings, Debt payoff, Other. Users can rename and add.
- **Your categories (owner sign-off, October 19, 2026; built October 20, 2026).** Me → Money & data → Categories, and "+ New" in the entry editor's category list. A category has a name (1–24 characters, trimmed, unique within money out or money in, ignoring case), a kind (money out or money in) and, for money out, the part of the budget it belongs to (needs, wants or save). Every category, built-in or the person's own, can be renamed and moved to another part. A built-in category can be hidden: it leaves the pickers, and entries already in it keep it. The person's own category can be removed: its entries, category rules, budget plan lines and spend-less goals move to a category the person picks, then it is deleted. New money-out categories join every zero-based budget from this month on with nothing planned. Categories sync in backups (a rename on one device reaches the other; newer wins) and are in the export. At most 40 of your own (owner sign-off, October 27, 2026).

### Money in & out (day 1)

*October 23, 2026: one place for each thing.* Your entries live on Money in & out's Transactions tab, grouped by day (the separate Entries screen was the same month's list twice; `/entries` opens it). Category rules and saved names sit on Me → Money & data → Categories. Insights' Money in & out card shows the last 6 months (the average a month and In / Out by month) rather than Home's figure again. "Running higher than usual" lives on Money in & out; the nudge links there ("See where") and Budget's over-plan card links there for the details.

The core summary every user sees: for each month, **total in (+)**, **total out (−)** and **net**, which is the "Kept this month" number on Home.

- Sources: uploaded statements and manual entries, merged into one transaction list.
- Month view: In, Out and Net at the top; then by category, by account, and the full transaction list; compared with last month.
- Credit cards: a purchase counts as Out on the day it is charged. The card payment from the bank account is a **transfer**, not spending, so nothing is counted twice.
- Transfers between the user's own accounts are excluded from In and Out.
- Users can recategorize any transaction, mark it as a transfer, or split it.

### Statement import (day 1)

Users upload files they download from their bank or card provider. Connected users may also link banks and cards read-only through Plaid (part of launch, owner decision, October 12, 2026). No stored bank credentials, ever.

| Format | Day 1 | How it's read |
|---|---|---|
| CSV | Yes | Column mapping (date, description, amount or debit/credit, balance), saved per account |
| OFX / QFX | Yes | Standard fields, including ending balance |
| PDF statements | Fast-follow, for a launch list of banks and card issuers | Fixed per-institution templates; others get "download CSV instead" guidance |
| Pay stubs | No | Income comes from bank deposits or manual entry |

- Flow: upload → choose or create an account (label, type: checking, savings or credit card) → preview parsed rows → confirm.
- Re-uploading overlapping periods is safe: each row has a fingerprint (account, date, amount, cleaned description) and duplicates are skipped.
- Ending balance is captured when the file includes it; it anchors the forecast.
- Categories come from a keyword table; a user correction can become a rule ("Always put CORNER MKT in Groceries"). No machine learning.
- Privacy: account numbers are masked to the last 4 digits; the file is parsed on the device and never uploaded; the user can keep a copy in device storage.
- Confidence: CSV and OFX parsing is reliable; PDF parsing is medium — layouts differ by bank and change without notice, so templates need monitoring and a fallback.

### Upcoming expenses & shortfall forecast (day 1)

- **Recurring detection:** same payee, amount within ±10%, at least 3 occurrences at a weekly, every-2-weeks or monthly interval (±3 days). Shown as suggestions; the user confirms, edits or dismisses. Users can also add bills and expected income by hand.
- **Upcoming list:** the next 30 days of expected expenses and income, with dates and amounts.
- **Forecast:** a day-by-day balance from today to the end of the month (or 30 days): starting balance + expected income − expected recurring expenses − typical daily spending (average of the last 90 days' non-recurring spending). Shows the lowest point and its date.
- **Shortfall warning:** if the lowest point falls below the user's safety buffer (default $0, user-set), show "You may be short $X around Oct 24" with a "how we calculated this" breakdown.
- Starting balance comes from the latest statement's ending balance plus transactions since, or a balance the user enters. With no balance, the app shows In vs Out only and asks for a balance.
- Always labeled an estimate based on the user's own history; no AI and no guarantees.
- **Forecast views, markers and what-if (owner decision, October 25, 2026).** Next 30 days looks a Month (30 days), Quarter (91) or Year (365) ahead (`SPANS`, remembered on the device in `stackd.forecast.span`; the screen title follows: "Next 30 days" / "Next quarter" / "Next year"); only the 30-day projection is stored in `forecasts` for Home and alerts. The status leads in one word, "Covered" (lowest point at or above the cushion; "Never below zero" when no cushion is set) or "Short" (the shortfall line), then one line. The chart marks today, a green "$" on every unmatched payday and a red dot on every unmatched bill, with a legend. "Try" (the what-if) has two dials: spend less each day ($1 steps up to typical daily spending) and set aside each payday ($10 steps up to the largest paycheck); both only change `forecast.project`'s inputs (daily spending lowered, a "Set aside" outflow on each payday), so no new rule; the result is drawn dashed beside the real line with a one-word verdict, the lowest point's change and the total set aside by the end. Quarter and Year list upcoming items as one row per month (in and out), each opening to its items.

### Emergency fund

- User enters monthly essential expenses (prefilled from Needs if budgeting is set up).
- Shows saved amount, runway in months, and milestones: $1,000 starter, 1 month, 3 months, 6 months.
- Target: 3 or 6 months suggested, or the person's own 1 to 12 months (owner, October 27, 2026; `emergency.summary` answers `invalid_target` outside that). ETA uses the user's planned monthly contribution.
- No "where it lives" explainer (removed with the Learn articles, October 18, 2026). No product names or rates.

### Goals & challenges (one model)

Everything is a **goal** of one of four kinds. Templates are pre-filled goals; jars are savings goals; group challenges are goals shared by several people.

| Kind | Sentence | Progress source |
|---|---|---|
| Save (jar) | Save **$2,000** for **Travel** by **Jun 2027** | Deposits the user logs |
| Pay off | Pay off **$2,400** on **Card A** by **Jun 2027** | Balance the user updates |
| Spend less | Spend **$150** less on **Dining** during **this month** | Entries and receipts vs. baseline |
| Habit | Do **7** days of **no eating out** starting **Monday** | Daily check-ins |

Rules:

- Users only fill the blanks; no custom formulas or nested rules.
- Active goal limits depend on the plan (see Plans & billing); limits live in config, not code.
- Jars are virtual; the copy must say money does not move.
- Spend-less needs a baseline: first month uses the user's own estimate, later months use a 3-month average.
- Launch challenge: the monthly savings challenge. Other templates (No-Eat-Out Week, Dining diet, No-spend weekend, 52-week saving) are fast-follow 4.

### Custom goals

Users set their own goals by choosing **Custom…** in any blank of the sentence. They fill in values; they never write rules. At launch: custom name, amount and date only — the extras below are fast-follow 3.

| Blank | Preset choices | Custom choice |
|---|---|---|
| What for | Travel, Kids' education, Emergency fund, New car, A home (added October 28, 2026, proposed) | Own name + icon + color |
| Amount | $500 / $1K / $2K / $5K | Any amount |
| By when | 3 preset dates | Any date, or no deadline |
| How often | — | Weekly, every 2 weeks, monthly, or on payday |
| Amount each time | Calculated | Or fixed by the user; the finish date is then calculated |
| Habit length | 7 / 14 / 30 days | Any number of days, 1 to 365 |
| Milestones | 25%, 50%, 75% (on by default) · 50% · 20%, 40%, 60%, 80% | Up to five whole percents from 1 to 99, changeable later on the goal screen, or none |

Also supported:

- **Ongoing goals** with no end ("Save $100 every month"): progress = running total + streak.
- **Milestones:** extra checkpoints (25%, 50%, 75% unless the person picks their own), each with its own celebration. Changing them on the goal screen never sets off a celebration: a new checkpoint the jar has already passed is recorded as reached quietly.
- **Why line:** the user's own reason, shown on the goal card.
- **Pause / resume** without losing progress or streaks.
- **Save as my template**, reusable and shareable to a group as a challenge.
- **Priority order:** the user ranks goals; the Home next-move card points to the top goal that is behind pace.

### Goals that grow (October 28, 2026; values proposed, awaiting owner sign-off)

A save jar with a date can **grow over time**, for goals years away (a child's college, a home, "their future"): a plain cash jar undercounts what such a goal needs. In the builder's jar options, "Grows over time" asks for today's cost (the amount blank, read as "$X today"), how fast the cost rises each year (suggestions 3% / 5% / 7% or the person's own, 0–500%; default 3%, 5% for Kids' education) and how fast what they save grows each year (3% / 5% / 7% or their own; default 5%, the same middle rate as Later). Choosing **Kids' education** or **A home** (a new "What for" suggestion) turns it on. The live line reads "About $X a month from now · $Y by <Month YYYY>" from `growth.goal_plan`. The jar keeps `goals.grow` = {today_cents, cost_rise_bps, return_bps, priced_on} and its `target_cents` is the future cost (recomputed by the rule on the goal screen; it changes only when the inputs or the rule do, since the cost is priced on `priced_on`). A grows jar has no cadence or ongoing option. The goal screen's "Grows over time" card leads with Ahead / On track / Behind from `growth.goal_pace` (deposits so far against the plan made on the pricing day), then the monthly amount from now, a bar of today's cost against the cost then with both ends labelled ("$2,000 today → $2,050 by April 2027", so it never reads as progress), the rates and the line "An illustration at the rates you chose, not a prediction or advice." A grows jar shows one monthly amount everywhere: the goal screen has no flat weekly pace (the future cost over the weeks left) and its first quick deposit is the monthly amount; the goal list and rows show "$X/month"; the behind-pace alert and Home's behind-pace move leave it out (its pace is `growth.goal_pace` on its own card); and What if's Spend less never fills it (its months-to-fill has no growth in it), so its card has no What if link. Backups and the export carry the field with the goal row.

### Groups

- At launch, one challenge type — the monthly savings challenge: each member saves toward their own target for the calendar month, ranked by % of their own target; it can repeat each month or be done solo. Other templates are fast-follow 4.
- Join by invite code (format `STK-XXXX`) or share link. Owner can remove members and regenerate the code.
- Leaderboard ranks **percent of each person's own target**. Dollar amounts are never shown to other members.
- Display name and avatar initial only; no emails visible to other members.
- Deleted users appear as "Former member".
- **What helped (October 28, 2026; proposed, awaiting owner sign-off; instead of a forum).** Once a member has reached their target, or the challenge has ended, the challenge screen asks "What helped?" with one fixed list of choices (no free text): Packed lunch, Cooked at home, No-spend days, Paused or cancelled a subscription, Set money aside on payday, Waited a day before buying, Used cash for treats, Shopped with a list. Up to 3, changeable. The group sees only the totals ("6 of 9 said Packed lunch"), and a member sees them only once at least 2 members other than themselves have answered (proposed, awaiting owner sign-off; October 28, 2026: counting the viewer's own answer let one of two answerers take hers away and read the other's), so no answer can be traced to one person; nobody is ever shown who chose what. Leaving the challenge or being removed clears the answer, and rejoining starts without it. The list lives in `stackd_rules/config/helped.yaml` (one source for the server and the app). The person's own answers are in their export, and leave the totals when the account is deleted. Saving is limited to 30 changes an hour per signed-in device (rate scope `group_helped`, proposed). An open forum stays in the parking lot (owner to discuss options).

### Receipts

- Take a photo or upload an image (JPEG, PNG, HEIC); PDF optional later.
- Fields: merchant, date, total, category, optional "count toward a challenge".
- Optional **Read text from photo** pre-fills fields, clearly marked for review; the user must confirm before saving.
- Photo retention setting: 90 days (default), 1 year, forever, or the person's own number of days (1 to 3,650). Entered amounts stay after photos are removed.
- When the photo's time runs out, the photo goes and so does the text read from it; the receipt record stays on the entry. When the person removes photos themselves (Remove photo on the entry, or Delete all receipt photos in Settings), the receipt records go with them and the entries stay without one (owner decision, October 28, 2026). A photo replaced by another, a deleted entry and a removed account take their receipts too.
- Anything that deletes photos at once asks first in a sheet with the real count (owner decision, October 28, 2026): Delete all receipt photos ("Delete all receipt photos?" / "This removes N photos from this phone, for good.") and a shorter keep time that would delete photos today ("Delete older receipt photos?" / "This deletes N photos older than <keep time>, for good."), each followed by "We don't keep a copy, and they aren't in your backup, so there's no way to get them back." and "Your entries and amounts stay.", with "Keep them" (focused first; a shorter keep time is then not saved) and "Delete N photos". With no photos the button reads "No photos to delete" and is disabled; afterwards "N photos deleted from this phone." Photos and receipt records never travel in the backup (they are not synced tables).
- Strip EXIF location data on upload.

### Bills & debt

- Bills list: confirmed recurring expenses with expected amount and due date; they feed Upcoming expenses and the forecast.
- Bills drive upcoming-expense alerts and the forecast; the Subscriptions view (below) adds what each subscription costs a year. Nothing is cancelled for the person.
- Bill tips (phone, internet, groceries) are static written guides.
- Debt avalanche: user enters cards with balance and APR; the app orders payoff by highest APR.
- **Debt you can feel (October 28, 2026).**
  - *Smallest balance first.* The payoff plan takes a fixed choice of order (a kind, so no own value): **Highest rate first** ("Saves the most interest.", the default) or **Smallest balance first** ("Clears a debt sooner."), kept in `settings` `debt.order` and synced like other settings. Both orders' debt-free month and total interest are shown side by side at the person's extra, each straight from `bills.payoff_plan`, so the trade-off is visible; the chosen one is outlined, and the debt list follows the chosen order. Education, not advice.
  - *Debt-free date on Home.* A Home card `debt_free` (Customize Home: "Debt payoff") leads with the month as the value ("Mar 2029", plain) and "Debt-free at this pace" from `bills.payoff_plan` at the person's extra and order (the payoff plan's card on Bills leads the same way, with the full month); **Stalled** with "Payments don't catch the interest yet" when the plan stalls; hidden with no debts. Opens Bills → Debt payoff (`/bills?tab=debt`). The progress line of debt paid since the first recorded balance is left out: debts keep only their current balance, so there is no first balance to measure from.
  - *Card spending vs payments.* Each credit card account shows `credit.card_trend` over the last 6 whole months (`card_trend_months`, proposed, awaiting owner sign-off): **Growing** / **Shrinking** / **Steady** and "Spent $X, paid $Y last month"; on a linked card it sits on its facts card, unlinked cards get a "Card spending vs payments" card on Debt payoff. Every entry of the card counts (Don't count included, since the balance moves either way); money in is payments, refunds and transfers in.
- **Credit habits (October 28, 2026; education only).** Makes Plaid's published use case "Track, manage, and build your credit" true (`docs/security/linking.md`): habits that build credit, shown from the person's own card data, with the fixed line "Education only. Qash never sees or shows a credit score." No score, no bureau data, no product names, no "you should".
  - *Due dates.* A linked card's due date is recorded each time its facts arrive (`card_due_dates`, Dexie v17: one row per card and due date with that statement's balance and minimum; in the encrypted backup (newer `updated_at` wins) so the history follows to a new device, in the export, deleted with the account). A card that isn't linked takes the person's own **Payment due day** (1–31, 31 = the month's last day; suggestions None / 1st / 15th / Last day plus their own) on the account in Accounts & imports (`accounts.due_day`); the rule derives that day of every month, clamped to the month's end.
  - *Payments* are the card account's money in, the transfer side included. Due dates before the card's first entry are not checked (`since`), so a new card never shows months it didn't exist as missed.
  - *Only what the person's own data shows.* A due date without the statement's balance takes what the card owed on that day from its balance points and entries (`forecast.start_balance` from the latest balance on or before it); nothing owed is on time, never Missed. With no balance on or before a due date, that due date is left out (not missed, not on time); when nothing can be checked the card says "Set the card's balance to start checking".
  - *What it shows.* One word: **Steady** (every checked due date on time), **Building** (the latest on time, a miss further back), **Missed** (the latest due date missed), **Start** (nothing to check yet); then "6 payments on time in a row", "18% of your limit used · under 30%" (when the limit is known), "Paid in full 3 months" (when the statements are known). On Insights (`credit` in INSIGHT_CARDS, shown once there is a credit card account), at the top of Bills → Debt payoff, and in detail at `/credit-habits` (each card, its next due date, its spending against payments, and three plain lines on why on-time payments, using less of the limit and paying the whole statement matter). The window is 12 months (`credit_habits_months`) and the guide 30% (`credit_guide_bps` 3000), both in `config/insights.yaml`, proposed, awaiting owner sign-off.

### Suggest, then take their own value (owner decision, October 27, 2026)

Wherever the app asks the person to pick a value, it offers a few suggestions **and** takes their own: a box beside the chips, checked against the same limits the server or the rule uses, with a plain message when it is outside them. A saved value that matches no suggestion shows in the box, never hidden. Today that covers your pay (when you're paid), the goal blanks (name, amount, date, habit length), jar milestones, challenge targets (and the 52-week "step up by $X each week": week n saves n × X, 1,378 × X in all), the extra on Debt payoff, the emergency-fund target, receipt retention, and in Alerts the days before a bill and its time, missed periods, the most per day and pause. A new picker follows the same pattern (`ChipsOrOwn`, or `CustomValueSheet` with `custom`). Fixed choices stay only where the value is a kind rather than a number (a goal's kind, a cadence, a channel, a weekday) or where the challenge itself defines it for every member (a seven-day week, a two-day weekend).

### One word first (owner decision, October 25, 2026)

Every card leads with one word of value to the person, then a short line that explains it, then the picture. The word is green when it is progress (Kept, Covered, Room, Up, Ahead, Sorted, Steady, Saved, Saving, Reached, Found; Done and Clear by owner decision, October 28, 2026; On track and Sooner proposed October 28, 2026; All good, proposed October 28, 2026), red when it asks for a look (Over, Short, Tight, Down, Behind, Review; Stalled proposed October 28, 2026), plain otherwise (Close: a budget line at 90% of plan or more; Helped / Shared on a challenge's What helped card, before and after answering; both October 28, 2026, proposed; Try, proposed October 28, 2026 for the What if card, Same, Start, Next, Top, None, Yearly, Monthly, Upcoming, Spent, Growing, Trial, Active, Ending, Paused, Ended, Stuck: a screen that stopped working, October 25, 2026). Debt & credit (October 28, 2026, proposed, awaiting owner sign-off): Shrinking and Building green; a debt-free date is not a word but the value itself ("Mar 2029", plain, like "$X kept") with the line "Debt-free at this pace", so nothing green reads as a claim about today; Stalled and Missed red; Growing plain on a card's spending; Steady green for credit habits and card spending. Signed-off words: Home (Kept / Over on this month, Covered / Short / Start on Next 30 days, Saved on Set aside, Next or Short on the next move, Steady / Over on Budget, Saving on Jars, Start on the setup card, Found on what statements turned up, Spent on Where it went), Insights (Kept / Over, Sorted / Review, Top, Upcoming / None, Room / Tight, Steady / Over, Up / Down, Ahead / Behind / Growing on Later; Start until there is something to show), Budget's buckets (Steady / Close / Over; Saving / Ahead for the save bucket) and zero-based (Assign / Done / Over), Bills (Upcoming), goal cards (Saving / Reached / Behind / Paused), the weekly recap (Kept / Over, Spent, Saved / Quiet, Upcoming / Clear), Fixed vs flexible (Up / Down / Steady, Kept / Over, Start; October 28, 2026, signed off October 29, 2026), the subscription check (Check / All good; proposed October 28, 2026) and the Plan screen (Active / Trial / Pending / Ending / Paused / Ended / Free). The short line keeps to eight words where it can. Me's main screen stays a list of settings rows; its word is on the Plan screen's current plan card. Goals keeps its own jar reordering (priority) instead of a Customize button (both owner sign-off, October 25, 2026). `app/layout/Word.tsx` holds the word lists and the colour rule.

### Time ranges (owner sign-off, October 20, 2026)

**Since October 25, 2026 (owner decision): Month · Quarter · Year · YTD · Next** replace 1M · 3M · 6M · 1Y · All everywhere. Month is this month so far, Quarter the last 3 months, Year the last 12, YTD January 1 through today (compared with the same days last year); bars are weeks up to 3 months, months beyond. **Earlier / Later** step a whole period back at a time (a YTD step back is the whole year before, compared with the year before that; a past period is compared with the whole period just before it), so all history stays reachable without "All"; "Earlier" is off when nothing came before. **Next** (Money in & out) looks 30 days ahead from the forecast: expected income, bills plus usual spending (typical daily × 30), what would be kept, in one word ("Saving" / "Over"; "Start" until pay or bills exist), and opens the day-by-day forecast. Ranges saved before map across (1M → Month, 3M and 6M → Quarter, 1Y and All → Year). The text below describes the October 20 design; where it says 1M / 3M / 6M / 1Y / All, read the mapping above.

How the person is doing over time, picked the way a stock chart's range is: one row of chips, **1M · 3M · 6M · 1Y · All**, above Money in & out, Where it went and Net worth. Home stays this month; its hero opens Money in & out. Each screen remembers its range on the device.

- **What a range is.** 1M is this month so far (the 1st through today); 3M, 6M and 1Y add the 2, 5 or 11 months before it; All starts at the month of the first entry. Each bar is a week for 1M and 3M (seven-day blocks from the range's first day, the last one cut at today), a month for 6M, 1Y and All, and a quarter for All once it spans more than 36 months.
- **What it shows.** Money in & out: Kept for the range, the average a month, In vs Out bars per step (In green, Out red), and the change against the period before. Where it went: each category's total for the range and its average a month. Net worth: the net on the day before the range starts, at the end of each month in it, and today, the change over the range in dollars and percent (green up, red down). Tapping a month's bar opens that month.
- **The period before** is the same range moved back by its number of months, day for day (3M on October 20 compares August 1 – October 20 with May 1 – July 20), so a month in progress is never compared with a whole one. All has no period before. When the person's first entry is after the period before starts, the comparison is left out ("not enough history yet") rather than set a whole range against a part of one.
- **Short history is said, never padded.** A range longer than the person's history starts where the data starts and says "You have N months so far"; no empty bars stand for $0. The average a month divides by the months in the range that have entries.
- **Net worth back in time** is rebuilt from each included account's balance points and its entries (an imported year of statements gives a year of net worth at once). An account counts from the day before its first entry or its first balance point, whichever is earlier; before that it is unknown and the point says it is partial. Items added by hand and Debt payoff debts have no past: each counts from the day it was added, and the chart says so.

### Insights (owner decision, October 18, 2026; replaces Learn)

- One summary card per area: money in & out, auto-sorted spending, bills & subscriptions, safe to spend, budget & jars, and net worth.
- **Net worth (owner decision, October 19, 2026).** What you own minus what you owe, from items the person chooses: their Qash accounts (latest balance; a credit card counts as a debt), the debts on Bills → Debt payoff, and anything they add by hand (investments, retirement, home, vehicle, other; mortgage, car loan, student loan, personal loan, other). Each Qash account and debt has an Include switch; hand-added items are kept with the date they were last updated, and the screen nudges an update after 30 days. On Connected, linked balances fill in the same way as accounts. The card shows the total, the change since last month and a bar of assets against debts; the screen shows both lists by group and a 12-month line from monthly snapshots. Values are the person's own or their latest balances, never fetched from anywhere, never advice. Kept on the device, in the export and the encrypted backup.
- Each card is a headline (the number or the win), one line of six to eight words about what it means for the user, and a small picture (bars, a ring, a sparkline, the next bills). Tapping opens the detail; each detail drills down to the items behind it.
- No articles, product names, affiliate links or live rates. Later (below) replaces the compound growth calculator and is labeled as an illustration, not a prediction.
- **Later (owner decision, October 25, 2026).** The growth calculator becomes a picture: `/insights/later` ("Later") projects the person's own savings to the age they choose to retire (any age, e.g. 62 or 67) through `growth.projection`: age now, retire at, saved now, each month, an optional goal, and three rates they set (low / middle / high, defaults 3% / 5% / 7%, signed off by the owner October 25, 2026). The chart shades the band between the low and high rates, draws the middle rate as the line and the goal as a dashed line; it leads in one word, "Ahead" (the middle rate reaches the goal) or "Behind" (with the monthly amount that would reach it), or "Growing" without a goal. Every field is the person's own, kept on the device in `settings` `later.plan`. Labelled an illustration at the rates they set, not a prediction or advice; returns vary and can be negative.
- **What if (October 28, 2026; values proposed, awaiting owner sign-off).** `/what-if` ("What if"), from an Insights card (word "Try"), from Bills → Debt payoff ("What if I put more on one loan?") and from a jar's screen. One lever at a time, a fixed choice of four: **Extra on a loan** (one debt from the Debt payoff list; a fixed-payment loan is a debt whose minimum is its payment; extra a month $50 / $100 / $200 or their own, and a "Pay half every two weeks" switch counted as one extra payment a year spread over the months, minimum ÷ 12 more a month, said plainly as an approximation), **Extra on all debts** (on top of the payoff plan's own extra), **Spend less** (one of the person's categories, $25 / $50 / $100 a month or their own, default Dining: what it does for the jar asked for, else the top jar by priority (never a jar that grows over time, which keeps its own monthly plan; chips read "$50", no plus, since it is money not spent), at the jar's pace = new money in over the last 3 months ÷ 3, and on the debts if it went there instead), **Set aside each payday** (a link to Next 30 days' Try card, never a second copy of its maths). Results lead with one word, Sooner / Same / Stalled, then e.g. "Debt-free 1 year 2 months sooner · $3,900.00 less interest" or "College jar done 2 years earlier" with the two months named (a count of 12 months or more reads in years and months). When the plan before the change never ends, the detail says "Instead of never at the minimums." for a plan of minimums alone, else "Instead of never at your current plan." Every number from `whatif.debt` / `whatif.goal`; "An illustration from your own numbers, not advice. Nothing is saved or moved."

### Subscriptions (owner decision, October 27, 2026)

`/subscriptions`, from Bills ("Subscriptions · N · $X a year"). Each confirmed bill that is a subscription, by what it costs a year (`recurring.yearly_cost`), with a bar for its share, its own charge and interval, a month's worth, and "Renews in N days". One word first: **Yearly**, "$X a year", "$Y a month across N subscriptions"; **None** when there are none.

- *Which bills count:* the person's own call when they made one (`recurring_series.subscription`: "It's a subscription" under Your other bills, "Not a subscription" on each one); otherwise the payee's latest recurring entry in the Subscriptions category. Income never counts.
- *How to cancel:* a sheet with plain steps for the service's own account page and for subscriptions paid through the iPhone (Settings → your name → Subscriptions) or Google Play. No per-merchant links: a link would be guessed and could go stale. "I cancelled it" removes the bill (`removeSeries`), so the forecast and alerts stop counting it; past entries stay. Nothing is cancelled for the person.
- *Renewal reminders* are the Bill due soon alert, at the days and time the person chose; the screen links to Alerts.
- The result is stored in `computed_results` (`subscriptions:<as_of>`) with the rules version. Nothing leaves the device.

- *Subscription check (October 28, 2026; proposed, awaiting owner sign-off).* Qash cannot see whether someone uses a service and never says "unused": it asks, and it points out facts from the person's own charges (`recurring.subscription_check`). A **Check** card leads the screen: one question at a time, highest yearly cost first ("Still using Hulu? $216 a year") with **Keep it** (stamps `recurring_series.checked_at` with today), **I cancelled it** (`removeSeries`, as above) and **How to cancel** (the sheet above), then the fact rows: a price rise ("Spotify went from $11.99 to $12.99"), services of the same kind ("3 video services · $47 a month together"), a free or $1 trial that became a charge ("Free trial became $14.99 on Oct 3") and a yearly or quarterly renewal close by ("Renews Nov 12 · $99"). Word: **Check** when something is there to look at, **All good** otherwise. A question comes back `subscription_ask_days` after the last Keep (90 days, proposed), or sooner when a yearly or quarterly one renews within `subscription_renewal_days` (14 days, proposed) and was not answered since its last charge. A trial is a first charge of at most `trial_max_cents` ($1.00, proposed) followed within `trial_window_days` (45 days, proposed) by a larger one. The thresholds live in `config/insights.yaml`. Kinds come from the hand-edited `subscription_kinds` table in `config/keywords.yaml` (video, music, cloud storage, news, fitness, food delivery, software; the kinds and their merchant words are proposed, awaiting owner sign-off), matched like the keyword table on the cleaned payee, first match wins; a payee no word matches has no kind. Home gets a small `sub_check` card titled Subscriptions ("Check · Still using Hulu? $216 a year", opening Subscriptions) that is hidden when nothing is asked. No push or email for any of this (owner: no nagging). Nothing leaves the device.

### Fixed vs flexible (October 28, 2026; signed off by the owner, October 29, 2026)

Answers "which are nice-to-haves and where do I have room?". Fixed is not the same as a need: a streaming service is fixed but a want; groceries are a need but flexible. **Fixed** is counted money out that belongs to a confirmed bill or subscription (the entry is `is_recurring`); **flexible** is the rest of counted money out. The person's own call per category wins over that reading (October 29, 2026): `settings` `fixed.override` = {category id: "fixed" | "flexible"}, passed to `cashflow.fixed_flexible` as `overrides`, so "Treat Rent as fixed" holds without a confirmed bill and "Treat Phone as flexible" holds with one; a category without a call follows `is_recurring` as before. Each is split by the category's bucket (needs / wants / save / none). How much you keep is Kept (In − Out) and the **kept rate** = Kept ÷ In (`cashflow.fixed_flexible`).

- *Card* on Insights and on Money in & out's month view ("Fixed vs flexible"): one word, then "11% kept · fixed $2,140 · flexible $1,300", a two-part bar (fixed, then flexible with its wants marked as room) and "Most room: Dining $310, Shopping $190" (the largest flexible wants categories, up to two; signed off by the owner, October 29, 2026). On Money in & out's card each room category is a link to What if. The word compares this month so far with the same days of last month (1st through the same day, clamped to its length, as in Time ranges): **Up** when the kept rate is higher, **Down** when lower, **Steady** when equal; **Kept** / **Over** by the sign of Kept when either month has no money in; **Start** when there is nothing this month. The same days of last month are signed off by the owner, October 29, 2026.
- *Detail* `/insights/fixed-flexible` (visual since October 29, 2026): the month as a ring (fixed, flexible, flexible wants as room) with the kept rate as the hero in its middle and each part's amount in the key beside it; **Most room**, the two largest flexible wants, each a row that opens What if → Spend less prefilled (`/what-if?lever=spend&category=<id>&amount=<cents>`, the amount being the largest of What if's own suggested amounts that fits inside that category's flexible spending, else that spending itself); the kept rate for this month so far and the 3 whole months before as bars (`KeptTrend`: one SVG unit per pixel, this month full strength, below zero red, months before the first with anything in or out left off); then by bucket and each category with its fixed and flexible amounts. Facts from the person's own entries; no advice.
- *Adjust* (top-right on the detail screen, `?adjust=1` opens it; Me search "Fixed or flexible categories"): "Adjust fixed vs flexible" lists each expense category spent in that month or already set, with this month's fixed and flexible amounts and three choices: **From bills** (the automatic reading; clears the call), **Fixed**, **Flexible**. A kind, so fixed chips; saved at once in `settings` `fixed.override`, synced like other settings, and read by every Fixed vs flexible card, the detail screen and Your month.
- Don't count entries and transfers are left out like every spending total; refunds net against their category, and against fixed when the refund itself is marked recurring, else flexible.

### Your month: the once-a-month review (October 28, 2026; signed off by the owner, October 29, 2026)

One screen that puts a whole month's pieces side by side, so the person can look back once a month and see one change worth trying. Nothing is computed twice: every section reads the same engine calls and hooks its own screen uses. Facts from the person's own numbers, never advice.

- *Where.* `/month-review` ("Your month"), for one whole calendar month: the month just ended unless `?month=YYYY-MM` asks for another. **Earlier / Later** step a month at a time; Later stops at the month just ended (the month in progress and the future are never reviewed), Earlier stops at the month of the first entry. Reached from a Home card `month_review` (Customize Home: "Your month") and an Insights card `month_review`. The Home card shows only during the first `month_review.show_days` days of a month (7, signed off by the owner, October 29, 2026; the person's own number from Adjust wins, below) for the month just ended, once that month has entries, and is hidden for good for that month after **Done** on the screen (`settings` `month_review.done.<YYYY-MM>`, synced like other settings). Both cards lead with Kept / Over for that month and "October: $420 kept".
- *Summary first* (October 29, 2026): the screen opens with **How it went** as a one-glance picture: Kept as the hero number with its unit small ("$1,190 kept", or "over"), the kept rate against the whole month before, In against Out as bars, and the kept rate by month for that month and the five whole months before it as bars (`KeptTrend`, that month full strength; months before the first with anything in or out left off). It always leads; the sections below follow the person's order.
- *Customize* (October 29, 2026): the sections below the summary (Budget, Fixed vs flexible, Jars, Debt, Subscriptions, One change) can be reordered and hidden with the shared card layout (`settings` `month_review.layout`, "Customize Your month" under them).
- *Adjust* (top-right, `?adjust=1` opens it; Me search "Your month on Home"): "Adjust Your month" has **Show on Home** (on by default; `settings` `month_review.home_card`, false keeps the card off Home, Insights keeps its card) and **For how many days of the month**: 3 / 7 / 14 days or the person's own whole number from 1 to 28 (`settings` `month_review.show_days`; 7 from the config until they pick). Both synced like other settings.
- *Sections*, each one word first, a short line and a small picture, each hidden when it has nothing for that month (never a row of zeros):
  - **How it went** (the summary above): In, Out and Kept for the month with the kept rate against the whole month before, from `cashflow.fixed_flexible` (the Fixed vs flexible word: Up / Down / Steady, or Kept / Over without money in), the in-and-out bars and the six-month kept-rate bars.
  - **Budget:** that month's budget through `budget.summary`: Over when a needs or wants bucket (50/30/20) or an expense line (zero-based) ended above plan, else Steady; the buckets, or the three lines most over (with none over, the three biggest planned lines), as bars against plan.
  - **Fixed vs flexible:** Money in & out's month card for that month, keeping to the split ("Fixed $2,140 · flexible $1,300", the bar and the room line): How it went already leads with the word and the kept rate, so they are said once.
  - **Jars:** new money into jars that month (moves between jars left out, as on Home), jars that reached their target that month (`goals.progress` reached at the month's end and not the day before it began), and each grows-over-time jar's pace at the month's end (`growth.goal_pace`). Word Reached, else Saved, else Quiet. Each jar with new money is a row with a ring of how far along it was at the month's end (`goals.progress` `display_bps`) and "+$X new".
  - **Debt:** today's debt-free month at the person's extra and order (`bills.payoff_plan`), leading as the value ("Mar 2029", plain) with "Debt-free at this pace", or Stalled, and each credit card's spending against payments that month (`credit.card_trend`, within its six-month window). Debts keep only their current balance, so no past balance change is shown for them; the picture is today's plan as a short line, the balance after each month (`series_cents`) down to the debt-free month, and each card's spending against payments as two bars.
  - **Subscriptions:** how many the subscription check asks about now (`recurring.subscription_check`) and what they cost a year, the count in a round chip; Check / All good, opening Subscriptions. The check is today's, so this section and the subscription_check candidate appear only for the month just ended.
- *One change* (`insights.one_change`). The device builds up to three candidates from that month and the engine picks one:
  - **over_plan**: the expense line most over its plan (zero-based: spent − planned, the largest; ties by the summary's order), or for 50/30/20 the needs or wants bucket most over (ties: needs first), with amounts = [over] and months = 1, so yearly = over × 12. A line counts as over only with something planned and outside the save bucket, the same lines Budget and the budget alert read (`paceLines`). Shown as a fact, "Dining $120 less a month → $1,440 a year" (a bucket reads "Wants $120 less a month → …"; whole dollars when the cents are zero) with **Try it in What if**, which opens `/what-if?lever=spend&category=<id>&amount=<cents>` (for a bucket, its category with the most spending that month).
  - **subscription_check**: the yearly cost of each subscription the check asks about now, amounts = those yearly costs and months = 12. Shown as "Check 2 subscriptions → $430 a year", opening Subscriptions.
  - **debt_interest**: with debts whose payoff plan is not stalled, `whatif.debt(debts, extra, add)` in the person's order (`debt.order`), with add = the over_plan amount, or $50 a month when nothing was over (`month_review.debt_add_cents` 5000, signed off by the owner, October 29, 2026); amounts = [interest saved] and months = the plan's months today, so yearly is the interest saved averaged over a year of today's payoff time. Shown as "$50 more a month on debts → about $310 less interest a year" with **Try it in What if** (`/what-if?lever=debts&amount=<cents>`).
  - The pick is the largest yearly amount; ties go by `one_change_order` in `config/insights.yaml` (over_plan, subscription_check, debt_interest), then by the device's order (the tie order signed off by the owner, October 29, 2026); zero or negative candidates are skipped, and with none left there is no card. The card has a before / after picture (October 29, 2026): over_plan as two bars, a month against a year; subscription_check as one bar per subscription's yearly cost; debt_interest as two bars of payoff time, today's debt-free month against the month with the amount added. Worded as an option from their own numbers, never "you should"; "An illustration from your own numbers, not advice." The pick is stored in `computed_results` (`one_change:<the month's last day>`) with the rules version. Nothing leaves the device.
- *What if prefill.* `/what-if` reads `lever`, `category` and `amount` (cents) from the address: a category the person has and a whole positive amount are selected as their own value; anything else is ignored.

### Notifications

Every notification type is user-controlled in Me → Alerts. Triggers are fixed rules evaluated by a scheduled job; no AI.

| Type | Trigger | User controls |
|---|---|---|
| Challenge check-in | Daily at the user's chosen time | On/off, time, days |
| Goal behind pace | Progress behind plan by the chosen number of periods | On/off, 1 or 2 periods, or the person's own up to 4 |
| Bill due soon | A recurring bill is due within the chosen days | On/off, 1 / 3 / 7 days before or the person's own 0 to 14; the time it goes out (09:00 unless chosen) |
| Milestone reached | A goal milestone is crossed | On/off; as it happens or one daily summary at a chosen time |
| Group activity | Member joins, challenge ends, rank changes | On/off; as it happens or one daily summary at a chosen time |
| Weekly recap | Chosen day and time | Push, email, both, or off |
| Budget alert (October 28, 2026; proposed) | A category (or, for 50/30/20, a bucket) reaches the chosen share of its plan this month | On/off (on by default), 90% / 100% or the person's own 50–150%; the time it goes out (09:00 unless chosen) |

Two more types, both day 1: **Upcoming expense** (an expected bill or recurring expense is due within the chosen 1, 3 or 7 days, or the person's own 0 to 14, at their chosen time (`alerts.schedule` `upcoming_expense.time`, 09:00 by default, RULES_VERSION 0.29.0); replaces "Bill due soon") and **Shortfall risk** (the forecast's lowest point drops below the user's buffer; on/off and buffer amount; sent once per first short date, not daily and not again when only the amount changes; as it happens or in one daily summary at a chosen time, default 7pm). Security alerts (see Security) are separate and always on.

Global controls: quiet hours (default 9pm–8am, user's time zone), a daily maximum (default 3, suggestions 1 / 3 / 5 / no limit or the person's own up to 20; extra items roll into one summary), and pause all for 1 day, 1 week, or through a day the person picks up to a year ahead.

Delivery: Web Push (VAPID) in the PWA; APNs and FCM in the native apps (Phase 2). The weekly recap is the one alert that can also go by email (fast-follow 6): the server schedules it from the preference's day, time and zone, and the message says only that the recap is ready, with a link to the app. Every send is logged with a dedupe key so nothing is sent twice. Because money data stays on the device, the device computes upcoming alerts and registers a minimal alert schedule (date, type, generic label — no amounts or merchants) with the server, which sends the push on time; the app shows the details when opened. On iPhone, web push works only after the PWA is added to the Home Screen (re-verify on current iOS before launch).

### Moments: messages, celebrations and encouragement

Owner decision, October 12, 2026: every message the product shows or sends lives in **one catalog**, `services/rules/stackd_rules/config/moments.yaml` (compiled by `scripts/build_moments.py` to `moments.json` for the API and `@stackd/rules/moments` for the app). Copy is changed there, never in a component.

- **Events** are named things that happened. Each lists its values (`vars`), its in-app toast lines and card lines, its effects (sound and confetti), how often it may show (`always`, `per_day`, `per_month`), and for a push type the fixed lock-screen label and the settings title.
- **In-app events:** `jar_deposit` (money into a jar, including Home's one-tap set-aside), `income_logged` (money in, saved by hand), `goal_reached` (a deposit crosses the target), `milestone_reached`, `debt_paid_down` (a payoff balance updated lower), `checkin_done` (habit), `spending_up` (a category running higher than usual, from the "More than usual" insight; once per category per month), `over_plan` (a budget bucket over plan; a card line), and for linked cards (chunk 3.5) `card_paid` (a statement paid in full; once a month per card) plus the card lines `card_plan`, `card_no_payday`, `card_past_due`, `card_no_due_date`.
- **Push types** keep the table above; their labels come from the same file and never carry a placeholder, an amount or a name (the build refuses one).
- **Nudges:** Home's next-move cards (`nudges`: title, detail, call to action, destination), one per `next_move` rule.
- **Effects:** a ka-ching (coins dropping into a box, synthesised on the device with Web Audio, no file) for money in and deposits; a soft chime for check-ins and milestones; confetti (small, or big for a goal reached) in the look's accent colours. Me → Look & feel has **Sounds** (with a bell button that plays it) and **Celebrations**, both on by default; confetti never plays when the device asks for reduced motion.
- **Tone:** warm, short, plain words. Spending more is normal: say what happened and something kind; never shame, never advise. A test fails on "should", "bad", "too much", "stop" or "must" in encouragement lines.
- **Determinism:** the variant shown is picked from the event's own id (FNV-1a), never at random, so the same moment always reads the same.

### Plans & billing

**Owner decision, October 22, 2026 (prices, trial and Founding cap):** a **3-day free trial** on either plan, no card (trials already running keep their own end); **Private $3 a month or $20 a year**, **Connected $7 a month or $65 a year**, monthly and yearly only (weekly prices were considered and dropped: a weekly price only reads cheaper while costing far more, and "Fair by design" is a promise on the website); Founding stays $150 for 4 years, now for the **first 250**. Cancelling a yearly plan refunds nothing and it runs to the end of the paid year, as before. Deleting the account on a yearly plan charges the months used, the current one included, at the monthly price and refunds the rest of what was paid for the year (never below zero, never more than Stripe's unused credit, less Stripe's card fee); "Before you subscribe" says so in its own lines and the box people tick names it (`CONSENT_VERSION` 2026-10-22). The trial reminder goes the day before the end.

**Owner decision, October 14, 2026: no lasting Free plan.** A new account picks one free trial, once per email inbox (owner decision, October 24, 2026: `otp.canonical_email` drops a +tag for every provider and folds Gmail's dots and googlemail.com; sign-in and mail keep the address as typed), with no card: Private or Connected (`plans.yaml` `trials`; 45 / 8 days until October 22, 2026, now 3 days on either). From day 2 the app asks for a card; a subscription bought during the trial is first charged when the trial ends (owner decision, October 28, 2026: through Stripe's trial with 49 hours or more left, else a billing cycle anchored on the trial end with no proration, so the first invoice is $0; under 31 minutes left the first charge is today and "Before you subscribe" says so). An email goes the day before a trial or a cancelled plan ends, and for a trial one fixed push beside it. **Founding reminders (owner decision, October 28, 2026):** as the 4 years end, an email and a push 30 days, 7 days and 1 day before (plans.yaml `founding.reminder_days_before`), each once (`subscriptions.founding_reminded_days`, migration 0033; a run that missed a stage sends only the nearest one): "Your Founding membership ends on <date>" ("ends tomorrow" the last time), a thank-you, and the plans to keep going with, priced from plans.yaml (Private $3 a month or $20 a year, Connected $7 a month or $65 a year), with "Nothing is charged unless you choose."; on the day, "Your Founding membership has ended": a thank-you, 7 days to pick a plan or download the data, and the device's data stays until they decide. Then the usual daily reminders and the 7 days as any plan's end. The pushes are fixed words with no prices (`push_founding_ends_soon`, `push_founding_ended` in moments.yaml). A paid plan's ended email says "Your Qash plan has wrapped up", never "trial". With no plan at the end, the app locks to subscribe-or-export for 7 days, then the account is deleted (`stackd-api plan-lifecycle`, hourly). The Free column below describes only what an account with no plan may do during those 7 days. Every web purchase records the "Before you subscribe" agreement (`purchase_consents`). Founding member: the first 200 only, showing places left; its value line is the saving against 4 years of Connected yearly (61%). With Yearly selected, plans show the yearly price first and the saving against monthly (Private 34%, Connected 20%).

Three plans. **Prices are decided; the feature split is a proposal to confirm before build.**

|  | Free | Private | Connected |
|---|---|---|---|
| Price | $0 | $20/yr (about $1.67/mo), or $3/mo monthly | $65/yr (about $5.42/mo), or $7/mo monthly |
| For | Trying it out | Privacy first: statements you upload are read on your device; never links | Automatic: link banks and cards read-only and every number stays current on its own; couples |
| How money data gets in | Manual entry, receipt photos, statements for 1 account | Manual entry, receipt photos, unlimited statements | Everything in Private, plus read-only linking through Plaid: up to 3 connections, banks or card issuers, each counting once (owner sign-off, October 27, 2026) |
| Where money data lives | Your device | Your device; the backup is encrypted before it leaves | Your device. Linked transactions pass through our server and are not kept there; we hold only an encrypted access token per connection |
| Data freshness | When you upload | When you upload | Automatic, 1–4 times a day |
| Analysis, charts, insights, forecast, nudges and push alerts | Yes | Yes | Yes, on linked data as well, current to the last sync |
| Card details from the issuer (balance, due date, limit, APR), utilisation, pay-by-due-date reminders | — | — | Yes, with card linking (chunk 3.5) |
| Savings jars and goals (kept, any kind: in progress, paused or reached; templates don't count; a challenge membership counts as one) | 2 | 4 + custom extras | 10 + custom extras |
| Group challenges | Join, 1 at a time | Join and create | Join and create |
| Receipt photos (kept on the device) | Yes | Yes | Yes |
| Encrypted backup + sync across devices | — | Yes | Yes |
| Couples / household | — | — | Yes |
| Export, delete, security, quiet hours | Yes | Yes | Yes |

Owner decision, October 10, 2026: jars and goals are capped at 2 / 4 / 10 (owner decision, October 18, 2026: the cap is the total kept, finished ones included; "Move to my templates" saves a jar as a template and removes it, freeing its place) (Founding members get Connected's 10); the website states the cap. Limits live in `plans.yaml` and are enforced by chunk 1.14. Owner decision, October 12, 2026: linking is part of Connected from launch; Private is the never-links plan.

Rules:

- **Connected ****is on sale at launch****** with couples / household and read-only bank and card linking (Owner decision, October 12, 2026: Phase 3 is part of launch).
- Safety alerts, security and data rights are never paywalled.
- Downgrading never deletes data: jars over the limit become read-only; leaving Connected revokes bank tokens and keeps everything already on the device.
- Entitlements are checked on the server; plan limits live in `plans.yaml`.
- PWA: Stripe hosted Checkout and Customer Portal; webhooks update entitlements. Native apps (Phase 2): Apple In-App Purchase and Google Play Billing into the same entitlement record.
- Fees: on the $3 monthly plan Stripe keeps about $0.39 (about 13%); on $20 a year about $0.88 (about 4%); on Connected $7 a month about $0.50 (7%), $65 a year about $2.19 (3%). Default the picker to annual.
- Connected margin = price − Stripe − (per-bank provider fee × banks). Get the provider quote before Connected goes live.
- **Changing plans (owner decision, October 17, 2026).** One subscription per person: Checkout refuses a second one while a plan renews (409 `already_subscribed`), and Founding can be bought only once the current plan is set not to renew (409 `cancel_first`). Switches happen in the app, never in the Customer Portal (its plan switching is off), and every switch starts at once (Stripe proration, invoiced immediately, `always_invoice`): an upgrade (Private → Connected, or monthly → yearly) charges the new price less the unused part of the old (a declined card changes nothing); a downgrade (Connected → Private, or yearly → monthly) leaves that difference as credit on the Stripe customer, spent on the next bills, never paid out while the account is open. A downgrade opens `changes.downgrade_after_days` (30, plans.yaml) after the plan started or last changed (`subscriptions.plan_changed_at`, 409 `downgrade_too_soon`), so nobody links banks on Connected for a day and drops back; upgrades are never held back. A downgrade to a plan without linking disconnects the linked banks at once (revoked at Plaid). Each switch shows today's charge or the credit it leaves, and the bank disconnect, behind the same tick box as a purchase.
- **Tester tools (owner decision, October 18, 2026).** An admin (email in the secret `STACKD_ADMIN_EMAILS`) sees "Tester tools" on the Plan screen and switches their own plan to No plan, Private, Connected or Founding for free (`users.tester_plan`, migration 0022; `POST /api/billing/tester`, step-up, audited, alerted; 404 for anyone else), and is never held by the 30-day downgrade wait. Entitlements and access follow the tester plan; billing actions (checkout, change, cancel, portal) always act on the real subscription. A locked switch down is a tappable "Switch to X from <date>" that explains the wait, not a disabled button.
- **US bank accounts too (owner decision, October 24, 2026).** Checkout also takes a US bank account (ACH Direct Debit through Stripe). A bank payment clears in up to 4 business days: the plan starts when it does (`checkout.session.async_payment_succeeded`; a subscription's own events go incomplete → active), a Founding place is held meanwhile (`incomplete` counts toward the cap, a failed payment, `expired`, gives it back), and a failed one (`async_payment_failed`) starts nothing and emails `bank_payment_failed_message`. In any delivery order (October 25, 2026): a failure that arrives before the checkout's completion still ends the subscription at Stripe (so no retry ever collects) and leaves a failed row that a late completion can't revive or use to hold a Founding place; a subscription whose creation arrives first starts only if its first invoice is paid (an open invoice is a bank debit still clearing). A refund keeps Stripe's bank fee, 0.8% capped at $5 (plans.yaml `refunds.bank_fee_*`), instead of the card fee. Checkout methods come from `STACKD_STRIPE_PAYMENT_METHOD_CONFIG` (else the Dashboard's default). Said on "Before you subscribe" (`CONSENT_VERSION` 2026-10-24), Stripe's page note, pricing, terms, FAQ and privacy. **Disputes (same day):** `charge.dispute.created` pauses the plan the charge paid for (`subscriptions.disputed_at`; access state `paused`, never deleted for it; the person gets `plan_paused_message`, the admins `dispute_admin_message`); `charge.dispute.closed` won or `warning_closed` brings it back (`plan_resumed_message`); lost ends every plan the charge paid for today (a renewing subscription at Stripe so it is never charged again, Founding here), stamps `subscriptions.dispute_lost_at` (migration 0029) and puts the account in access state `ended` (owner decision, October 25, 2026): the plan is over and the inbox can't buy again, the account stays open (download, erase or delete) and is never closed for it, so the terms' "Nothing is deleted because of a dispute" holds; the person gets `plan_ended_dispute_lost_message`. `disputed_at` stays set, so deleting still refunds nothing more. **Disputes, deletion and buying again (same day):** deleting an account with a disputed payment (open or lost) refunds nothing more, credit included (`deletion._disputed`, `deletion_refund` returns 0 for a `disputed_at` row), and `refund_credit` never refunds a charge Stripe marks `disputed`, since the bank has already returned that money. A lost dispute adds the inbox to `purchase_blocks` (a keyed pseudonym of `otp.canonical_email`, kept after deletion, lifted by hand) and the card or bank account's fingerprint to Stripe's default Radar block list (`card_fingerprint_blocklist` / `us_bank_account_fingerprint_blocklist`, best effort); `POST /api/billing/checkout` answers 403 `purchase_blocked` for a blocked inbox. **Early fraud warnings:** `radar.early_fraud_warning.created` with `actionable` refunds the charge in full (reason `fraudulent`, tag `fraud_warning:<charge>`, once), ends the plans it paid for today, blocks the inbox and card the same way, and emails `fraud_refund_message` to the person and `fraud_admin_message` to the admins; a warning Stripe marks not actionable changes nothing.
- **US cards only (owner decision, October 17, 2026).** Payments are accepted only from cards issued in the United States (directly or through Apple Pay, Google Pay or Link), enforced in Stripe by a Radar rule `Block if :card_country: != 'US'`; the other payment methods (Klarna, Cash App Pay, Amazon Pay) are off; US bank debits were added October 24, 2026 (below). The refund fee (2.9% + 30¢) is the US card rate, so it matches what Stripe keeps. Said as "Credit or debit cards issued by a US bank: Visa, Mastercard, Amex, Discover" on "Before you subscribe", the pricing page, the terms, the FAQ and above the pay button on Stripe's page (Checkout `custom_text`), because a Radar decline only says "Your card was declined".
- **Refunds on deletion (owner decision, October 17, 2026).** Deleting the account ends every Stripe plan at once. The current billing month is kept (from the monthly anniversary of the period start; `stripe_billing.month_end`) and the rest is refunded at the price paid: for a renewing plan, Stripe's unused credit (`create_preview` with `cancel_now`) times the share after the month's end; any credit in full; for Founding, the share of the payment after the month's end (rounded down). Each refund is paid less Stripe's card fee (owner decision, October 17, 2026: the cost of a benefit most apps don't give), `refunds.fee_bps` 290 + `fee_fixed_cents` 30 in plans.yaml, the percentage rounded half up, once per refund, never more than the refund; the Delete account screen shows unused − fee = refund. The amount is worked out once and kept on the row (`subscriptions.refund_due_cents`, migration 0021) until paid. Credit is never cash while the account is open (downgrades only); cash only on deletion; cancelling refunds nothing. A plan behind on payment ends with no refund for the unpaid period. `GET /api/billing/credit` gives the credit and the refund so the Delete account screen shows the amount before anyone confirms; the Plan screen shows the credit. The terms, "Before you subscribe" and every switch say so (`CONSENT_VERSION` 2026-10-18). Refunds are spread over the customer's charges, newest first, with idempotency keys so the purge's retry never pays twice. Store plans are refunded by the stores. **When Stripe is unreachable at the deletion (October 25, 2026):** an hourly job (`settle-deletions`) retries until Stripe answers; the refund is worked out as of the deletion day (later months never count as used, Stripe's credit is taken back to that day), and any charge Stripe made after the deletion, such as a renewal, is refunded in full with no fee.
- Show price, renewal terms and how to cancel before purchase; cancel in two taps. State automatic-renewal requirements get a one-time legal review before launch.
- Free trial length: 3 days on either plan (owner decision, October 22, 2026).
- Built in chunk 1.14 (October 10, 2026) and signed off by the owner on October 27, 2026: the split above is what `plans.yaml` enforces. Confirming or changing it is an edit to that file; the picker copy in `features/billing/PlanScreen.tsx` must follow.

### Founding member offer (day 1)

- **$150 one-time for 4 years of Connected** — $37.50 a year, about 42% below Connected yearly ($65; 61% below the earlier $95.88). The first 250 only (200 until October 22, 2026). Places taken are counted one way everywhere (`entitlements.founding_taken`: every Founding purchase except a failed bank payment, `expired`; a place refunded because its bank payment cleared after the account was deleted stays taken, owner decision October 28, 2026), by the pricing page, the Plan screen, checkout and the webhook that grants it; the webhook counts and takes the place under one lock for the whole offer, so two buyers paying for the last place at once never both get it (October 25, 2026).
- Sold only on the website and PWA through Stripe; Apple and Google subscriptions don't support a 4-year term, so the native apps honour it but don't sell it.
- Includes every Connected feature from day 1: read-only bank and card linking (up to 3 connections), couples / household.
- Doesn't auto-renew. 30 days before the end, the member chooses a plan; nothing is deleted.
- Limited to the first [N] members or until [date]. Refund policy: owner decision before the offer opens.
- Margin check before launch: $150 − Stripe fees ≈ $144, or $36 a year. If the bank-link provider charges per connected bank per month, 3 banks over 4 years could cost more than that — get the quote and keep the 3-bank cap.

### Couples & household (Connected)

- Invite one partner into a household of two. Each person keeps their own private data.
- Shared by choice: household jars (balances and who added what), shared goals, and an optional combined In / Out summary (totals only).
- Shared data is end-to-end encrypted with a household key created on the inviter's device and passed in the invite link, never to our server.
- Leaving a household: each person keeps a copy; shared jars are split by the contribution record.
- Ships at launch together with encrypted sync (chunk 1.16). Connected and Founding members get it automatically.

## Settings spec

Settings lives under the **Me** tab (owner decision, October 18, 2026): a short hub, one screen per group, and **Search settings** at the top. The hub shows the search box, who you are with your plan (opens Account & plan), Install (in a browser tab only), one row per group, then Log out and Delete account, so deletion stays two taps from Me. Search runs on the device over every setting, inside the groups too, and matches everyday words ("logout", "sign out", "password", "theme", "refund"); a result names its group, opens that screen and briefly highlights the setting; no match suggests a word to try. From 900px a group's screen sits beside the list of groups and the search box. Mockups: Settings (each look) for native, PWA · Settings for the web (they show the older single list).

| Group | Items | Behavior |
|---|---|---|
| Account & plan (`/me/account`) | Your plan, Your name (Edit), Email (change) | Email change requires a new OTP |
| Sign-in & security (`/me/security`) | Manage passkeys, Active devices, Recent activity, Auto-lock, Backup & sync | Sign out any device remotely |
| Money & data (`/me/data`) | Accounts & imports, Linked banks & cards, Keep receipt photos (90 days / 1 year / forever), Delete all receipt photos, Storage on this device, Download all my data | Export is built on the device |
| Alerts (`/me/notifications`) | Push on this device; What you get and when: one switch per type, its "when" choices under it while it is on; How often: quiet hours, most per day, pause all | Push needs PWA permission; explain first |
| Groups & household (`/me/groups`) | Challenges & members, Couples & household | Owner-only actions marked |
| Look & feel (`/me/look`) | App look picker, Dark mode, Match system, Simple layout, Sounds, Celebrations | Instant restyle, look saved to account; Match system overrides Dark mode while on |
| Help & legal (`/me/help`) | Help & contact, Privacy policy, Terms of service, Data we never collect, Open-source licenses, app version | Policy and terms open as web pages |
| Account (on the hub) | Log out, Delete account | See below |

**Accounts & imports row.** Lists the user's accounts (label, type, last 4 digits), import history per account with rows added and skipped, saved CSV column mappings, a balance entry per account, and the user's category rules. Deleting an account removes its imported transactions after confirmation.

**Backup & devices row (Private and Connected).** Turn end-to-end encrypted backup on or off, see the last backup time, restore on a new device, save a recovery key, and list devices that sync. Free users see an export reminder instead.

**PWA differences.** The App look picker is replaced by one line: "More looks available in the iOS and Android apps." An **Install Stackd** row opens the install guide (hidden once installed). Notifications rows explain that iPhone push needs the app on the Home Screen.

**Notifications screen.** One row per notification type (see Feature specs → Notifications) with its switch and options, then quiet hours, daily maximum, and pause all. The PWA asks for browser permission only after the in-app explainer.

**Cancelling (owner decision, October 13, 2026).** Cancel plan stops renewal; it never cuts a paid period short. A monthly plan stays on until the end of the billing month already paid for (a month from the last charge, not the calendar month end), a yearly plan until the end of the paid year, then the account is Free and nothing is deleted. Keep my plan undoes it any time before then. Both are done in the app (`POST /api/billing/cancel` and `/resume`, step-up, audited, with the always-on plan alert); cancelling needs the "If you cancel" sheet's box, "I have read and understood these terms.", ticked, and the lines shown are kept like a purchase's (`purchase_consents.kind` purchase / change / cancel, migration 0023; owner decision, October 18, 2026; each point is a one- or two-word headline over a short line). **Plan history (owner decision, October 18, 2026):** Me → Plan lists what happened to the plan, newest first, with the date and time: free trial started, subscribed (price), switched (charged, or became credit), cancelled (runs until), kept, plan ended. The server keeps these in `plan_events` (plan, period, amount, dates; no card data; deleted with the account) and they are in the export; Stripe's portal stays for receipts and switching. The Founding membership is one payment for a fixed term and never renews, so there is nothing to cancel: it runs to its end date. Plans bought in a store are cancelled in that store.

**Plan & billing row.** Shows the current plan and renewal date, opens the plan picker, and links to manage or cancel (Stripe Customer Portal on web; the App Store or Google Play subscription page in the native apps).

**Authentication**

- Email + 6-digit OTP, valid 10 minutes, single use, max 5 attempts, then 15-minute lockout (owner sign-off, October 27, 2026).
- Passkey (WebAuthn) required at sign-up: Face ID on iPhone, device passcode as fallback; auto-lock (5 minutes by default, 5 to 60 by the user's choice) and step-up checks (see Security).
- Sessions: refresh tokens per device, listed under Active devices, revocable.
- Rate-limit OTP sends per email and per IP.

**Download all my data**

- Produces a ZIP: `profile.json`, `entries.csv`, `goals.json`, `groups.json`, `budgets.json`, `settings.json`, and a `receipts/` folder of photos.
- Built on the device and saved directly; server-held data (account, groups, plan) is added through one authenticated request.

**Delete account**

- Reachable in-app in two taps from Me (Apple requirement) and via a public web page (Google Play requirement).
- Dialog explains what is deleted, offers "Download my data first", and requires typing DELETE.
- Deletes profile, entries, goals, receipt photos, sessions and group memberships; group history shows "Former member".
- Grace period and backup purge timing: **open question for legal**; state the timing in the privacy policy.
- Send a confirmation email when deletion completes. Deletion also wipes this device's local data and the encrypted backup; other signed-in devices wipe their local data the next time they open.

## Data model

All money is stored as integer cents (`*_cents`). All tables carry `id` (UUID), `created_at` and `updated_at`; user-owned rows carry `user_id` and are access-checked on every query.

| Table | Key fields |
|---|---|
| users | email (unique), display_name, look, mode, simple_layout, receipt_retention, created_at, deleted_at |
| sessions | user_id, device_label, last_seen_at, revoked_at |
| budgets | user_id, month (YYYY-MM), method (`50_30_20` \| `zero_based`), take_home_cents |
| budget_lines | budget_id, category_id, planned_cents |
| categories | user_id (null = default), name, bucket (`need` \| `want` \| `save`) |
| entries | user_id, date, amount_cents, merchant, category_id, source (`manual` \| `receipt`), receipt_id, is_recurring |
| receipts | user_id, storage_key, ocr_text, ocr_engine_version, status (`pending` \| `confirmed`), purge_after |
| goals | user_id, kind (`save` \| `payoff` \| `spend_less` \| `habit`), title, target_cents or target_days, label, start_date, end_date, baseline_cents, group_id, status |
| goal_events | goal_id, date, type (`deposit` \| `balance_update` \| `checkin`), amount_cents |
| groups | owner_id, name, template_key, invite_code, start_date, end_date |
| group_members | group_id, user_id, joined_at, left_at |
| emergency_fund | user_id, essentials_cents, saved_cents, target_months (1–12), monthly_plan_cents |
| debts | user_id, label, balance_cents, apr_bps, min_payment_cents |
| computed_results | user_id, kind, as_of, rules_version, payload (JSON) |
| export_jobs | user_id, status, file_key, expires_at |

No table stores bank credentials, account numbers or full card numbers. APR is stored in basis points (2799 = 27.99%). `users.look` holds the look picked on either platform; a platform that doesn't offer it shows Modern. Also: webauthn_credentials (user_id, credential_id, public_key, sign_count, device_label, created_at, last_used_at); and for Phase 3, bank_connections (user_id, provider, item_ref, token_ref in the key vault, scopes, status, last_synced_at, revoke_after).

**Where each table lives (local-first)**

| Location | Tables |
|---|---|
| Device (IndexedDB) | accounts, statement_imports, csv_mappings, entries, categories (user), merchant_rules, recurring_series, balance_anchors, budgets, budget_lines, goals, goal_events, goal_milestones, goal_templates (private), receipts and photos, emergency_fund, debts, forecasts, computed_results |
| Server (PostgreSQL) | users, sessions, webauthn_credentials, subscriptions, entitlements, groups, group_members (with % progress only), shared goal_templates, notification_prefs, notification_settings, push_subscriptions, notification_log, alert_schedule (user_id, due_at, type, generic_label, dedupe_key), backups (user_id, blob_key, created_at, size, key_version — ciphertext only), audit_log, households, household_members, household_blobs (ciphertext only), bank_connections (Phase 3) |

export_jobs is no longer needed: exports are built on the device.

**Tables added for custom goals, notifications, billing and security**

| Table | Key fields |
|---|---|
| goals (new fields) | icon, color, why_text, cadence (`weekly` \| `biweekly` \| `monthly` \| `payday`), per_period_cents, is_ongoing, paused_at, priority |
| goal_milestones | goal_id, label, target_cents or target_date, reached_at, updated_at |
| goal_templates | owner_id, name, payload (JSON), shared_group_id |
| notification_prefs | user_id, type, enabled, time_of_day, days, lead_days, threshold |
| notification_settings | user_id, quiet_start, quiet_end, daily_max, paused_until, timezone |
| push_subscriptions | user_id, platform (`web` \| `ios` \| `android`), endpoint/token (encrypted), created_at, revoked_at |
| notification_log | user_id, type, dedupe_key (unique), sent_at, channel |
| subscriptions | user_id, plan (`free` \| `p``rivate \| connected \| founding`), source (`stripe` \| `apple` \| `google`), external_id, status, renews_at |
| entitlements | user_id, key, value, derived_from (subscription id) |
| audit_log | actor_id, action, target, ip_hash, at — sign-ins, exports, deletions, plan changes, admin actions |

**Tables added for imports and the forecast**

| Table | Key fields |
|---|---|
| accounts | user_id, label, type (`checking` \| `savings` \| `credit_card` \| `cash`), last4, institution, currency |
| statement_imports | user_id, account_id, format (`csv` \| `ofx` \| `pdf`), template_key, period_start, period_end, ending_balance_cents, rows_added, rows_skipped, file_key (null once deleted), status |
| entries (new fields) | account_id, import_id, direction (`in` \| `out`), raw_description, clean_description, fingerprint (unique per account), is_transfer, transfer_pair_id, split_parent_id, note (≤ 200 characters), tags (≤ 5, each ≤ 24 characters, one per spelling in any case; October 19, 2026) |
| csv_mappings | account_id, column map (JSON), date format, sign convention |
| merchant_rules | user_id (null = global keyword table), match text, category_id |
| recurring_series | user_id, payee, kind (`bill` \| `income`), expected_cents, interval, next_date, status (`suggested` \| `confirmed` \| `dismissed`), subscription (the person's call), checked_at (the last "Keep it" on the subscription check, a date) |
| balance_anchors | account_id, as_of, balance_cents, source (`statement` \| `user`) |
| forecasts | user_id, as_of, rules_version, lowest_cents, lowest_date, payload (day-by-day JSON) |
| net_worth_items (device) | kind (`asset` \| `debt`), group (`cash` \| `savings` \| `investments` \| `retirement` \| `property` \| `vehicle` \| `other_asset` \| `card` \| `mortgage` \| `auto_loan` \| `student_loan` \| `personal_loan` \| `other_debt`), label, value_cents (hand-added only), source (`manual` \| `account` \| `debt`), ref_id, included, updated_at |
| net_worth_snapshots (device) | month (YYYY-MM, unique), assets_cents, debts_cents, net_cents, rules_version |

## Calculation rules

Every rule is a pure function in `stackd_rules`: inputs + `as_of` in, result out, no I/O. Each has golden tests.

| Rule | Formula | Edge cases |
|---|---|---|
| 50/30/20 targets | needs = 50%, wants = 30%, save = 20% of take-home | Rounding remainder goes to save |
| Your own split (`budget.targets_split`, October 20, 2026) | needs / wants / save = the person's shares of take-home; 50/30/20 is the suggested start | Shares are whole bps 0–10000 summing to 10000, else `invalid_split`; rounding remainder goes to save; `budget.summary` plans the bucket method by `split_bps` when given |
| Bucket spent | sum of entries in month whose category maps to bucket | Future-dated entries excluded |
| Zero-based left to assign | take-home − sum(planned lines) | Negative shows as over-assigned |
| Kept this month | Money in & out's Net for the month: Month In − Month Out (`cashflow.month_totals` `net_cents`; see "Rules added for money in & out") | May be negative: Home then says "$X over"; needs no take-home. Resolved October 22, 2026: the earlier "take-home − spent, floored at 0" was the budget-era definition; `budget.summary` still reports it as `kept_cents` and no screen shows it |
| Emergency runway | saved ÷ monthly essentials, 1 decimal | Essentials = 0 → hide runway |
| Emergency ETA | ceil((target − saved) ÷ monthly plan) months | Plan = 0 → "set a monthly amount" |
| Save goal progress | sum(deposits) ÷ target | Cap display at 100%, keep true value |
| Payoff progress | (start balance − latest balance) ÷ start balance | Balance up → progress can fall |
| Spend-less progress | baseline − period spend in category | Baseline = user estimate in month 1, then 3-month mean |
| Habit progress | days checked in ÷ streak length | One check-in per calendar day, user's time zone |
| Weekly pace | (target − current) ÷ ceil(days left ÷ 7) | Past deadline → show overdue |
| Group rank | sort by progress %, ties by earliest reach time | Hide members with no events yet |
| Recurring series | same payee, amount within ±10%, 3+ occurrences at a weekly, every-2-weeks or monthly interval (±3 days) | Flag only; user confirms |
| Yearly cost (`recurring.yearly_cost`, October 27, 2026; RULES_VERSION 0.30.0) | per series: expected × charges a year (weekly 52, every 2 weeks 26, monthly 12, quarterly 4, yearly 1); a month = a year ÷ 12, half-even; totals summed, the month total = total ÷ 12 | Sorted by yearly cost desc, then label, then id (code point); unknown interval `invalid_interval`; a negative amount or past 2^53 − 1 cents `invalid_amount` |
| Fixed vs flexible (`cashflow.fixed_flexible`, October 28, 2026; RULES_VERSION 0.38.0) | between two dates inclusive, with Month In / Out's rules (transfers excluded, a refund with an expense category nets against Out): optional `overrides` {category id: "fixed" \| "flexible"} (October 29, 2026; null = none) decides the part for every entry of that category, refunds too, before `is_recurring` is read; fixed = money out of entries marked `is_recurring` (or in a category set "fixed") minus their refunds, flexible = the rest of money out minus its refunds; each also split by the entry's bucket (need / want / save / none); by category: fixed, flexible and out; room = categories in the want bucket with flexible > 0, largest first; kept = In − Out; kept rate = round_div(kept × 10000, In) bps | kept rate null when In = 0 and may be negative; one category with two buckets is `invalid_bucket`; `overrides` that is not a record, or a value other than "fixed" / "flexible", is `invalid_overrides`; uncategorized entries take no override; categories ordered by out desc, then uncategorized last, then id in code-point order; room ties by id |
| Subscription check (`recurring.subscription_check`, October 28, 2026; RULES_VERSION 0.38.0; thresholds proposed) | per subscription, its charges up to as_of sorted by date then amount: `price_rise` (October 28, 2026 review fix): the most recent increase is the latest charge k ≥ 1 whose amount is above charge k − 1's; `price_rise` = {from = charge k − 1's amount, to = the latest charge's amount, date = charge k's date} when there is one, it is not the trial pair's step (k = 1 with a trial pair), every charge since k is at charge k's amount (a later drop clears it) and no Keep is on or after charge k's date, so a rise stays shown after more charges at the new price until the person answers; `trial_turned_charge` = {trial, charge, date} when the first charge ≤ `trial_max_cents` and the next charge is larger and within `trial_window_days` of it, and no Keep on or after that charge's date; `renewal` = {date, cents} for a yearly or quarterly one whose next date (rolled forward by its interval to today or later, each step back on the next date's own day of the month clamped to the month, as `forecast.upcoming`'s `day`, so a 31st never drifts) is within `subscription_renewal_days`; `ask` = never answered, or `subscription_ask_days` or more since the last Keep, or a renewal not answered since the last charge, or a price rise or trial shown; kind = the first `subscription_kinds` word inside the cleaned payee; yearly and monthly as `recurring.yearly_cost`; `duplicates` = kinds held by ≥ 2 subscriptions with their count and monthly together = round_div(Σ yearly, 12) | items sorted like `recurring.yearly_cost`; duplicates by monthly together desc, then kind; a Keep dated after as_of counts as answered; no charges → no price rise, no trial; an unknown interval, or one that is not text, `invalid_interval` (also in `recurring.yearly_cost`); a missing threshold `invalid_thresholds` |
| Debt avalanche order | sort by APR desc, then balance asc | Equal APR and balance → by label |
| Long-range projection (`growth.projection`, October 25, 2026) | for each rate (1–3, ascending, 0–500%) and each whole year k from the age now to the retirement age: balance = S × (1 + r)^m + P × ((1 + r)^m − 1) ÷ r with r = rate ÷ 12, m = 12k, S = saved now, P = put in each month, exact and rounded half-even once per point; contributed = S + P × m; the middle rate is index (count − 1) ÷ 2, rounded down; with a goal G > 0: reaches = middle balance at retirement ≥ G, monthly needed = max(0, (G − S × (1 + r)^M) × r ÷ ((1 + r)^M − 1)) at the middle rate, M = 12 × years, rounded half-even | r = 0 → S + P × m, needed = (G − S) ÷ M; no goal → reaches and needed are null; ages 16–99 now, retirement after now and at most 100 (`invalid_age`); negative amounts `invalid_amount`; a rate out of range `invalid_rate`; none, more than 3 or not ascending `invalid_rates`; any amount in or out (saved now, each month, the goal, a balance, contributed, monthly needed) above 9,007,199,254,740,991 cents (2^53 − 1) `too_large`, so both engines always agree to the cent (October 27, 2026; 500% a year over decades reaches it). An illustration at rates the person sets, never a prediction or advice |
| Goal that grows (`growth.goal_plan`, October 28, 2026; RULES_VERSION 0.35.0) | months n = calendar months from as_of's month to the target's month (days ignored); cost months m = from `priced_on`'s month (default as_of) to the target's month; future cost F = T × (1 + c ÷ 12)^m; what is saved grows by g = (1 + r ÷ 12)^n; the monthly amount P, put in at each month's end, solves F = S × g + P × (g − 1) ÷ (r ÷ 12), so P = max(0, (F − S × g) × (r ÷ 12) ÷ (g − 1)); r = 0 → P = max(0, (F − S) ÷ n); saved grows to S × g; already enough = S × g ≥ F; exact fractions, each output rounded half-even once | T ≤ 0 or S < 0 `invalid_amount`; a rate outside 0–500% `invalid_rate`; `priced_on` after as_of or a bad date `invalid_date`; target before as_of `deadline_in_past`; target in as_of's month `too_soon`; more than 1,200 cost months (100 years, proposed) `too_far`; any output above 2^53 − 1 cents `too_large`. An illustration at rates the person sets, never a prediction or advice |
| Grows-jar pace (`growth.goal_pace`, October 28, 2026) | k = calendar months from the start's month to as_of's month; expected = P × (k + 1) (this month included); deposited ≥ expected + P → ahead; deposited < expected − P → behind; else on track (one month's amount either way, proposed) | P < 0 `invalid_amount`; start after as_of `invalid_date`; P = 0 is always ahead |
| What if, debts (`whatif.debt`, October 28, 2026) | before = `bills.payoff_plan(debts, extra, order)`, after = `bills.payoff_plan(debts, extra + add, order)`, with the person's order (`settings` `debt.order`; null or absent = avalanche); each side's months, debt-free month and total interest; months sooner = before − after, interest saved = before − after, both null when either side is stalled; status `stalled` when after is stalled, `sooner` when before is stalled or after is fewer months, else `same` | add < 0 `invalid_amount`; the payoff plan's own errors and 600-month stall |
| What if, a jar (`whatif.goal`, October 28, 2026) | months = 0 when nothing remains, null when the amount a month is 0, else ceil(remaining ÷ a month), null past 1,200 months (proposed); now at `per_month`, new at `per_month + add`; finish = as_of's month + months as YYYY-MM; months sooner = now − new when both exist; status `never` when new is null, `sooner` when now is null or new < now, else `same` | Negative amounts `invalid_amount`; bad as_of `invalid_date` |
| One change (`insights.one_change`, October 28, 2026; RULES_VERSION 0.38.0; order proposed) | for each candidate {kind, amounts_cents, months}: yearly = round_div(Σ amounts × 12, months); candidates with yearly ≤ 0 are skipped; the pick is the largest yearly, ties by the kind's place in `order` (config `one_change_order`), then the earlier candidate; returns {index, kind, yearly_cents} or null | candidates not a list, or one not a record, `invalid_candidates`; a kind not a string or not in `order` `invalid_kind`; amounts not a non-empty list of integers `invalid_amount`; months not an integer ≥ 1 `invalid_months`; `order` not a non-empty list of distinct strings `invalid_order` (checked first) |
| Range totals (`cashflow.series`, October 20, 2026) | between two dates inclusive, split into steps (`week`: seven-day blocks from the start, the last cut at the end; `month` / `quarter`: calendar months or quarters, the first and last cut at the range); each step's In / Out / Net with the Month In / Out rules; the range's In / Out / Net and Out by category; `active_months` = calendar months in the range with at least one non-transfer entry; averages a month = range total ÷ active months, half-even; `first_date` = the earliest entry date given | End before start is an error; no active months → averages null; a step with no entries is 0 (the screen starts the chart at the first step with data); the period before is a second call with `cashflow.period_totals` |
| Net worth history (`networth.history`, October 20, 2026) | for each date asked: each account's balance = the latest balance point on or before it plus entries after that point through the date, else the first point after it minus entries after the date through that point; ≥ 0 is an asset, < 0 a debt of its absolute value; items count from their `since` date; assets, debts, net per date; `change_cents` = the last known net − the first known net, null with fewer than two known dates | Dates ascending and unique; an account with no balance point is never counted; an account is unknown before the day before its first entry or its first point, whichever is earlier, and the date is marked `partial`; a date where nothing is known has net null |
| Net worth (`networth.summary`) | assets = Σ asset items, debts = Σ debt items, net = assets − debts; each group's total (assets first, then debts; larger first, then by name); debt share = debts ÷ assets in bps; change = net − the previous snapshot's net | Net may be negative; no assets → debt share null; no previous snapshot → change null; amounts ≥ 0 (a negative account balance is entered as a debt); a group must belong to its kind; ids unique |

**Next move (Home card).** A fixed priority list; the first rule that applies wins:

1. No take-home pay set → "Set your monthly pay".
2. Payday today and nothing set aside yet this pay period → "Payday. Set aside $X before it goes", one tap logs a jar deposit (owner decision, October 10, 2026). X = the month's save target × this paycheck ÷ monthly take-home; without a save target, 10% of the paycheck (owner sign-off, October 27, 2026).
3. Emergency fund under $1,000 → "Build your $1K starter fund".
4. Any debt with APR ≥ 15% → "Attack your highest-APR card" (threshold owner sign-off, October 27, 2026).
5. A confirmed bill is due within 3 days → "Plan for [bill] on [date]".
6. Runway under 3 months → "Grow your emergency fund".
7. Otherwise → "Start a savings goal".

**Shortfall first:** when the forecast shows a shortfall, that warning replaces the next-move card until the forecast clears.

Rule order and thresholds live in a versioned config file, not in code.

**Rules added for Home** (October 10, 2026)

| Rule | Formula | Edge cases |
|---|---|---|
| Verdict | Kept = Got − Spent; "You spent less than you got" when Kept ≥ 0, else "You spent $X more than you got" | Nothing in yet → no verdict |
| Spend meter | Spent ÷ Got in basis points | Got = 0 → hide the meter; over 100% shows red |
| Set-aside target | the budget's save bucket for the month (50/30/20: 20% of take-home; zero-based: planned save lines); no budget → 10% of take-home (owner sign-off, October 27, 2026) | No take-home → no target |
| Set aside so far | jar deposits logged this month, dated today or earlier | Future-dated deposits don't count |
| Paydays set aside | a payday counts when a deposit falls in its pay period (that payday up to the day before the next, or month end) | No pay settings → not shown |
| Payday nudge | save target × paycheck ÷ monthly take-home, half-even; no target → share × paycheck | Take-home = 0 → the share |

**Rules added for the debt payoff planner** (fast-follow 1, October 10, 2026)

| Rule | Formula | Edge cases |
|---|---|---|
| Payoff plan (avalanche or snowball; `order` since October 28, 2026, RULES_VERSION 0.36.0) | month by month: each debt accrues round_half_even(balance × APR bps ÷ 120 000), pays its minimum, then the rest of a fixed monthly budget (every minimum + the extra, so a paid-off debt's minimum rolls on) goes to the first debt in the order and spills to the next. `order` "avalanche" (the default, also for null or absent): APR descending, balance ascending, label, id; "snowball": starting balance ascending, then APR descending, label, id (code-point order), fixed for the whole plan; anything else `invalid_order`; a debt is paid off in the month its balance reaches 0; months counted from the month after `as_of`; outputs months to debt-free, the debt-free month, total interest, total paid, each debt's payoff month and interest, and the total balance after each month | No debts → 0 months; a zero balance is paid in `as_of`'s month; past 600 months the plan is `stalled` (minimums under the interest) and every figure is null; extra < 0 → `invalid_amount` |
| Interest saved by an extra payment | the plan with the extra against the plan with extra = 0, on the device: months and interest sooner | Either plan stalled → no comparison |

**Rules added for couples & household** (October 10, 2026)

| Rule | Formula | Edge cases |
|---|---|---|
| Shared jar split | each member's contribution = the sum of their own deposits to the jar; on leaving, each keeps a jar holding only their own contributions | A member with no deposits keeps an empty jar; balance updates and check-ins never count; a deposit by a member not in the list is an error, so nothing is dropped silently |
| Combined In / Out | In = Σ members' In, Out = Σ members' Out, Net = In − Out; totals only, never entries | Nobody sharing → nothing shown; a member twice is an error |

**Rules added for custom goals and notifications**

| Rule | Formula | Edge cases |
|---|---|---|
| Custom jar (launch) | name trimmed of spaces, 1–10 characters (owner decision, October 10, 2026); amount > 0; deadline today or later, or none; pace = weekly pace with nothing saved yet | Past date → "pick a date after today" |
| Per-period amount (deadline set) | (target − saved) ÷ periods left, by cadence | Payday cadence uses the user's pay dates |
| Finish date (amount fixed) | today + ceil((target − saved) ÷ per-period) periods | Per-period = 0 → "set an amount" |
| Ongoing goal | running total; streak = consecutive periods with a deposit ≥ plan | Paused periods don't break the streak |
| Milestones (fast-follow 3) | checkpoints as basis points of the target, each `pct_of(target, bps)` half-even; reached when saved ≥ it; the device stamps `reached_at` the first time it sees it | Checkpoints are 1–10 000 bps; none → error |
| Jar split (fast-follow 3) | moving money from jar A to jar B is a `withdrawal` event on A and a `deposit` on B for the same amount; a jar's saved = deposits − withdrawals | A withdrawal above what is saved is refused on the device |
| Next move: goal behind pace (fast-follow 3) | the top-priority active goal whose expected-by-now exceeds its saved by at least one period's amount, before "start a goal" | Paused goals and reached goals never qualify |
| Behind pace | expected-by-now − saved ≥ threshold × per-period | Paused goals never alert |
| Notification send | trigger true AND type enabled AND outside quiet hours AND under daily max AND dedupe key unused | Over max → add to next summary. A type set to one daily summary (shortfall risk, milestone reached, group activity) is checked after pause and before quiet hours: it joins the summary at its chosen local time today, or tomorrow once that time has passed (RULES_VERSION 0.20.0). A type is enabled only by `true`: every switch in the prefs must be `true` or `false` (a 1 or "yes" is `invalid_settings`), and a type left out is off (October 28, 2026, RULES_VERSION 0.32.0) |
| Shortfall alert key (`alerts.schedule`, October 28, 2026, RULES_VERSION 0.33.0; owner decision) | `shortfall:<first short date>` | Once per first short date: the same date with a different short-by amount keeps the same key, so a small change in the amount never alerts again; a new first short date gives a new key. The key the server stores carries no amount. `matched` on an upcoming item is `true`, `false` or left out |
| Budget pace (`budget.pace`, October 28, 2026, RULES_VERSION 0.38.0; proposed, awaiting owner sign-off) | for each line with planned > 0: the highest level L in `levels_bps` with spent × 10000 ≥ planned × L (exact products); `spent_bps` = `money.ratio_bps(spent, planned)`; `days_left` = month end − as_of + 1 (today counts) | Lines under every level, or with nothing planned, are left out; spent may be negative (refunds) and then crosses nothing; `levels_bps` strictly ascending, each 1–100000, else `invalid_levels`; `as_of` outside `month` is `invalid_date`; a repeated category is `duplicate_line`; lines keep their input order |
| Alert tag (`alerts.tag`, October 28, 2026) | 16 letters a–p from FNV-1a 64 over the UTF-8 of `salt` + ":" + `value` (each hex digit → a letter) | `value` and `salt` non-empty text without a lone surrogate (UTF-16 half; Python cannot encode one and JavaScript would write U+FFFD), else `invalid_inputs` (the same check answers `invalid_account` / `invalid_description` in `fingerprint.row`); the salt is a random value kept on the device (`settings` `alerts.tag_salt`, synced in backups so every device makes the same keys) |
| Budget alert key (`alerts.schedule` `budget`, October 28, 2026) | one alert per crossed item: `budget:<YYYY-MM of today>:<tag>:<level_bps>`, due today at `budget_pace.time` (09:00 unless chosen), or now when that time has passed | A tag that is not 16 letters a–p is `invalid_inputs` (a name or id can never reach the key); each level fires at most once per category per month; the server refuses a `budget_pace` key of any other shape and picks the label from the level (≥ 10000: "has reached its plan") |
| Engine boundaries (every rule, October 28, 2026, RULES_VERSION 0.32.0) | Any integer in or out past 2^53 − 1 (JavaScript's largest exact integer) is `too_large`, amounts parsed from text too; products such as cents × bps are exact in both engines and only the rounded answer must fit. A date pushed past year 1 or 9999 is `invalid_date`. A JSON `null` for a rule's optional argument means the default, as if left out, while a field inside an object follows Python's `dict.get` (null is not the default, as `alerts.schedule`'s `time`); a list where an object is expected (or the reverse) is the rule's own invalid-input code | The device and the server always give the same answer for the same input |
| Plan limit check | count(kept items) < entitlement value; for goals, every goal not removed counts, reached ones included, templates never (owner decision, October 18, 2026) | Downgrade → read-only, never delete |

**Rules added for money in & out, imports and the forecast**

| Rule | Formula | Edge cases |
|---|---|---|
| Month In | sum of positive transactions in the month, excluding transfers | Refunds net against their category unless the user marks them as income |
| Month Out | sum of negative transactions in the month, excluding transfers | Credit card purchases count on the charge date |
| Net (kept) | In − Out | Shown in red when negative |
| Week In / Out / Kept (fast-follow 6) | the same sums between two dates inclusive (`cashflow.period_totals`); the weekly recap uses the seven days ending today and the seven before | End before start is an error; a single day is a valid range |
| Transfer match | opposite amounts between two of the user's accounts within 5 days, or a payment keyword (PAYMENT, AUTOPAY, TRANSFER) | Suggested; user confirms; unmatched card payments flagged for review |
| Row fingerprint | hash(account, date, amount, cleaned description, occurrence index); cleaning turns every run of whitespace into one space, trims, and upper-cases ASCII letters only; whitespace is one fixed list in both engines (JavaScript's `\s`: tab, line feed, vertical tab, form feed, carriage return, space, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF; October 27, 2026) | Identical same-day charges kept via occurrence index |
| Categorize | first matching user rule → keyword table → "Uncategorized" | User rules always win; nothing else guesses (the fast-follow 7 model was removed October 28, 2026, owner decision: no AI in the code) |
| Correction to rule (fast-follow 7) | changing an entry's category offers "Always put <merchant> in <category>"; accepting writes a merchant rule and moves past uncategorized, non-transfer entries whose cleaned description contains the cleaned merchant | Already-categorized entries are never touched |
| Typical daily spending | non-recurring Out over the last 90 days ÷ 90 | Under 30 days of history → budgeted needs + wants ÷ days in month |
| Upcoming occurrences (`forecast.upcoming`; `day`, October 28, 2026, RULES_VERSION 0.31.0) | each series from its next date (rolled forward if past) by its interval through as_of + days; a monthly, quarterly or yearly series may carry `day` (1–31), and each step lands back on that day of the month, or the month's last day when it is shorter, so the 31st never drifts to the 30th | `day` on a weekly or every-2-weeks series, or outside 1–31: `invalid_series` |
| Forecast balance (day d) | start + expected income up to d − expected bills up to d − typical daily spending × days elapsed | Expected items already matched to a real transaction are not counted twice |
| Shortfall | min(forecast balance) < buffer | Re-evaluated after every import, entry or bill change |
| Recurring intervals (fast-follow 8) | adds quarterly (gaps 80–100 days, next = last + 3 months) and yearly (350–380 days, + 12 months) to weekly / every 2 weeks / monthly; a quarterly or yearly run needs 2 occurrences, the others 3 | Same payee, amounts within ±10% of the median; suggested only |
| Safe to spend (fast-follow 8, `insights.safe_to_spend`) | over the forecast days from today through `until` (the day before the next payday, else the forecast's last day): safe = max(0, lowest balance − buffer); per day = round_div(safe, days in the window) | Money beyond the usual daily spending the forecast already counts; never negative; an empty window is an error |
| More than usual (fast-follow 8, `insights.vs_usual`) | per expense category: this month's net spend (out − refunds, no transfers) from the 1st through today's day of the month, against the same days (clamped to month length) of each of the previous 3 months that have any entries; usual = round_div(sum, months used); flagged when increase = current − usual ≥ `usual_increase_cents` and current × 10000 ≥ usual × (10000 + `usual_increase_bps`) | Needs at least one prior month with entries; sorted by increase, then category id; thresholds in `config/insights.yaml` (owner sign-off, October 27, 2026) |
| Bigger months ahead (fast-follow 8, `insights.lumpy_bills`) | each confirmed quarterly or yearly bill, rolled forward to its next date on or after today; months to save = calendar months from this month to the due month counted inclusively (due this month → 1); set aside per month = round_div(amount, months to save); per calendar month over the next 12, the total of those bills, `big` when ≥ `lumpy_month_cents` | Weekly to monthly bills are the forecast's job; sorted by due date, then payee |
| Largest and most often (`insights.top_spending`, October 20, 2026) | between two dates inclusive, money out only (no transfers; refunds and money in are left out): `largest` = the `limit` biggest single amounts, ties by later date then id; `merchants` = entries grouped by the payee cleaned like a fingerprint, each with its count, total and latest date and the latest entry's own name (ties by id), ordered by count, then total, then payee; `count` = the entries considered | End before start is an error; `limit` 1–20; an entry with no payee is in `largest` but in no merchant |
| Seasonal spike (fast-follow 8, `insights.seasonal`) | for each of the next 2 calendar months: the same month last year's net out against the mean net out of the 12 complete months before this one that have entries; flagged when increase ≥ `seasonal_increase_cents` and last year × 10000 ≥ mean × (10000 + `seasonal_increase_bps`) | Needs that month last year plus at least 6 months of history; an estimate, never a prediction |
| Consolidation what-if (fast-follow 8, `bills.consolidation`) | today: `payoff_plan` with extra = payment − every minimum; consolidated: balance = total + round_div(total × fee_bps, 10000), each month interest = round_div(balance × APR, 120000) at the intro APR for the first `promo_months` and the offer APR after, then pay min(payment, balance); saves = today's interest − (consolidated interest + fee) | Payment below the minimums is an error; past 600 months either side is `stalled` with nulls; an illustration with no product names, never a recommendation |
| Card utilisation (chunk 3.5, `credit.utilization_bps`) | round_div(balance × 10000, limit) in bps; the balance is the card's statement balance when there is one, else its current balance | Null when the limit is missing or 0; a balance below 0 (a credit) counts as 0; may pass 10000 (over the limit). A fact about the card, with a one-line explainer that lenders look at it; never advice |
| Card spending vs payments (`credit.card_trend`, October 28, 2026) | per whole calendar month over the `months` before as_of's month (from the month of the card's first entry on, oldest first): spent = Σ money out, paid = Σ money in, net = spent − paid; trend "growing" when spent > paid in each of the last 3 complete months, "shrinking" when paid > spent in each, else "steady"; `last_month` = the latest month listed | Fewer than 3 months listed → trend null; no entries → no months; the current month and later are left out; `months` 1–120 else `invalid_months`; the caller passes every entry of the card account (Don't count included) |
| Credit habits (`credit.habits`, October 28, 2026) | due dates = the given ones ∪ `statements`' due dates ∪ (with `due_day` 1–31) that day of every month clamped to its end, only in months with no given or statement due date (October 28, 2026 review fix: one due date a month, never a second one that looks missed); checked = due dates on or after as_of − `months` months, on or after `since` when given, and before as_of. For each checked due date d: window = (the previous known due date, or d − 1 month, d]; on time when Σ payments in the window ≥ its minimum (the statement's own, else `minimum_cents`) when that is known and > 0, else when Σ > 0; or when its statement balance is known and ≤ 0 (nothing owed). Paid in full when Σ ≥ its known statement balance. on_time_streak = consecutive on-time due dates back from the latest checked; paid_in_full_streak = consecutive paid-in-full back from the latest (null when the latest has no known balance); status steady (streak = checked) / missed (the latest missed) / building (otherwise); utilization via `credit.utilization_bps`; under_guide = utilization ≤ `guide_bps`; next_due_date = the first due date on or after as_of | With `balance_history` ({anchors, entries}), a due date with no statement balance is owed = max(0, −start_balance(latest anchor on or before it, entries through it)); no anchor on or before it → left out of checked and counted in `unknown`; owed 0 → on time and paid in full. With `until` (the last day the card's data reaches: the latest of its entries, balances and statement period ends, and for a linked card the last sync day), a due date after `until` that the payments seen do not make on time is left out of checked and counted in `unknown`, never missed: its payment may simply not be in yet (October 28, 2026 review fix). No checked due dates → status null; a due date of today is still open; `due_day` outside 1–31 → `invalid_day`; `months` 1–120 else `invalid_months`; null utilization → under_guide null. Education only: no score, no bureau data |
| Pay in full by the due date (chunk 3.5, `credit.pay_in_full`) | paid = last payment if its date is on or after the statement date, else 0; remaining = max(0, statement balance − paid). Status: `no_balance` (statement balance ≤ 0), `paid` (remaining = 0), `no_due_date` (the issuer sent none), `past_due` (as_of after the due date), otherwise split remaining across the given paydays from as_of through the due date: each gets ⌊remaining ÷ n⌋ and the first (remaining mod n) get one cent more; with no payday in the window, one payment on the due date (`no_payday`). `days_left` = due − as_of | Read-only: Qash shows the plan, it never moves money. The due date also joins the reminder schedule as an upcoming bill (`card-<account>`), so the existing Upcoming expense alert covers it |

## Accessibility, privacy & security

**Accessibility (WCAG 2.2 AA target)**

- Contrast rules from Theme rules; checked in CI for all six combinations.
- All controls are real buttons, links or inputs with labels; toggles expose `aria-pressed` or are switches with `role="switch"`.
- Text scales to 200% without loss of content; no fixed-height text containers.
- Charts and progress rings have a text equivalent (e.g. "69% of $600").
- Screen-reader pass on iOS VoiceOver and Android TalkBack before launch.

**Privacy**

- Collect only what features need: email, display name, user-entered amounts, receipt photos.
- No ad SDKs, no third-party analytics that sell or share data; if product analytics are used, self-host and anonymize.
- Receipt photos: EXIF stripped, retention per user setting, deleted on account deletion.
- Group members never see each other's dollar amounts or emails.
- Privacy policy must list data collected, retention, deletion timing, and the "never collect" list. Which US state privacy laws apply is part of the one-time legal review before launch.

**Security**

- TLS everywhere; HSTS; strict Content Security Policy on the PWA.
- Encryption at rest for database and object storage.
- Signed, expiring URLs for receipt photos and exports; never public buckets.
- Authorization check on every row by `user_id`; integration tests for cross-user access.
- Upload limits: images only, max 10 MB, re-encoded server-side.
- Secrets in a managed secret store; no secrets in the client bundle.
- Dependency scanning and the AI-package denylist in CI.

**Security program (beyond passkeys and sign-in)**

No AI removes some risks, but Stackd still stores spending habits, debts, receipt photos and group connections. Sign-in proves who someone is; these controls protect the data behind it.

- **Ownership:** one named person is responsible for security; a written security plan and a yearly risk assessment.
- **Authorization tests:** automated tests that try to read and change another user's data, on every endpoint.
- **Abuse limits:** rate limits on code sends, sign-in attempts, invite-code joins, uploads and exports.
- **Audit log:** sign-ins, exports, deletions, plan changes and admin actions; no amounts or receipt contents in logs.
- **Backups:** encrypted, with a restore tested every quarter; deletion purges backups on the stated schedule.
- **Admin access:** least privilege, hardware-key sign-in for staff, every admin action audited.
- **Push and billing secrets:** VAPID keys, Stripe keys and webhook secrets in the secret store; verify every webhook signature.
- **Vendors:** review the security and data handling of hosting, email, push and payment providers.
- **Before launch:** an outside penetration test and a written incident-response plan with breach-notification steps.
- **Regulation:** whether the FTC Safeguards Rule (GLBA) covers Qash is part of the one-time legal review before launch. Its core pieces — a responsible person, a risk assessment, a written plan — are adopted either way.

**Account security (day 1)**

- **Mandatory MFA:** sign-up = email one-time code + passkey creation. On iPhone the passkey is unlocked with Face ID; the device passcode is the fallback for devices or users without biometrics. Native apps (Phase 2) add direct Face ID.
- **Auto-lock:** after 5 minutes of inactivity the app locks; reopening needs the passkey (Face ID or device passcode). Owner decision, October 12, 2026: the user chooses the window, whole minutes from 5 to 60 (default 5), in Sign-in & security → Auto-lock, by slider or by typing the number. It is stored on the account (`users.lock_after_minutes`), applies on every device, and the server enforces the same window (`require_unlocked`). Only what the person does counts as activity (owner decision, October 28, 2026): calls the app makes on its own (syncs, timers, the alert schedule, refreshes) carry `X-Qash-Background: 1`, and the server, like a request another site or a page load makes (`Sec-Fetch-Site` not `same-origin`, `Sec-Fetch-Mode: navigate`), serves them but never counts them; when the app's screen locks it tells the server (`POST /api/auth/lock`), and the session stays locked there until the next passkey check. Changing it needs a fresh passkey check, since a longer lock is weaker, and is audited (`lock_changed`).
- **Step-up check:** re-verify with the passkey before linking a bank, exporting data, deleting the account, changing email or phone, or changing plan — even when unlocked.
- **Always-on security alerts** (email, plus push if allowed; users cannot turn these off): new device or sign-in, new passkey, bank connected or disconnected, data export requested, email or phone changed, deletion requested, plan or billing change. Money alerts stay user-controlled.
- **Signing in on another device (owner decisions, October 19, 2026).**
  - *Passkey in the email box (built):* Sign in asks the browser, quietly, for a Qash passkey to offer in the email field's autofill list (`autocomplete="email webauthn"`, WebAuthn conditional mediation over the existing `/api/auth/passkey/options` + `/verify`); picking it is one Face ID or Touch ID tap. The request is renewed after 4½ minutes on focus and cancelled before an email code is sent. Browsers without it show nothing extra.
  - *Link with your phone (built October 19, 2026; B2 `/signin/phone`, B3 `/link` and Me → Link a device; B4 the passkey offer on the computer right after):* a computer shows a Qash QR code and an 8-character code; on a signed-in phone, Me → Link a device scans it in Qash (or the code is typed) and, after a fresh passkey check, Approve signs the computer in. Requests expire after 2 minutes (owner sign-off, October 27, 2026) and each is answered once: approved or denied, then closed, so a second answer or one after expiry is 409 and changes nothing (owner decision, October 28, 2026), at most **3 link requests per hour per IP** (owner), the approval screen names the requesting browser and system; when the phone and the computer are on different networks it warns and asks the person to confirm before approving (owner); every approval is audited and sends the always-on new-sign-in alert. Afterwards the computer **offers** its own passkey (owner: offered, not required). It works in any browser without Bluetooth. Trade-off, recorded: the browser's own phone sign-in proves the phone is nearby over Bluetooth, which makes it phishing-resistant; linking by camera does not, so the security documents, the privacy page and the Plaid answer say sign-in is a passkey, or approval by a phone that holds one (owner to update Plaid).

**End-to-end encrypted backup (Private and Connected)**

- At launch: the device encrypts the backup before upload; the server stores ciphertext it cannot read.
- The key is created on the device and protected by the user's passkey where the platform supports it, with a printable recovery key as the fallback. Lose both and the backup cannot be recovered — say so plainly at setup.
- Restore on a new device: sign in with email code + passkey, then unlock the backup.
- Removals are remembered for 180 days (`TOMBSTONE_HORIZON_DAYS`; October 28, 2026). A device drops removals older than that after a sync, but only while backup is on and its last full pull from the server is within the 180 days; with backup off it keeps them all, so a later restore that brings two devices together still tells a removal from a row it never had (household sharing never reads removals, so it changes nothing here). Removals in tables whose rows may carry no time of their own (budget lines, categories, milestones) are never dropped. The device keeps the newest removal it dropped (`backup.tombstones_pruned_before`, this device only) and every backup carries it as `tombstones_pruned_before`; a merge then never adds another device's row that this device lacks when that row's own time (`updated_at`, else `created_at`; none counts as oldest) is at or before that record, and a device takes the newer record from any backup it merges, a restored one included. A row missing from a backup never deletes anything; only a removal does. A device away for longer than 180 days may keep rows removed elsewhere meanwhile; it never brings them back to the others.
- Confidence: medium on passkey-protected keys across all browsers; prototype in chunk 1.16.

**What the app can know: statements only vs connected accounts** (October 11, 2026; a planning input for pricing, not a commitment)

Everything in the first column is built and runs on the device from imported statements and manual entries (Free and Private). The second column is what Connected's read-only linking adds; it is being built for launch in chunks 3.3–3.5 (Owner decision, October 12, 2026). **Owner decision, October 11, 2026: read-only card linking joins Phase 3 alongside banks** (chunk 3.5).

| Capability | Statements only: Free, Private (built) | Connected: linked banks and cards (building for launch) |
|---|---|---|
| Income and spending | Month and week totals, categories, refunds and transfers, from whatever was imported | The same, for every linked account, without remembering to import |
| Freshness | As of the last import | Automatic, 1–4 times a day |
| Completeness | Only accounts the user imports; a missing card skews every number | Every linked account, so totals and the forecast see the whole picture |
| Recurring bills and income | Detected after 3 monthly occurrences (2 for quarterly / yearly), confirmed by the user | Detected the same way, but from day one of linking because history arrives with the link |
| Forecast and shortfall warning | Starts from a statement's ending balance or a typed one, goes stale between imports | Starts from the live balance every sync |
| Safe to spend until payday | Built, as fresh as the balance | Re-computed after every sync, including pending charges |
| Pending transactions | Not visible | Visible before they post, so a warning can come before the charge lands |
| Spending by account / card | Built, for imported accounts | Every linked account and card |
| Running higher than usual | Built, from the user's own months | The same, mid-month and current to the day |
| Bigger months ahead and seasonal spikes | Built; seasonal needs a year of imported history | Linked history (often 12–24 months) makes it work from the first week |
| Credit card details | Only what the user types into Debt payoff (balance, APR, minimum) | Statement balance, due date, minimum and credit limit straight from the issuer (card linking only) |
| Card utilisation and pay-in-full-by-due-date reminders | Not possible without the limit and due date | Possible with card linking (both are parking-lot items needing sign-off) |
| Consolidation what-if | Built, from typed balances and APRs | The same, pre-filled from linked balances and APRs |

Holding the line in both columns: read-only, no money movement, no bank passwords (see the rules below), every number computed by the same versioned rules, nothing phrased as advice, no product names or affiliate offers. Pass-through processing means linking does not change local-first for the results: data flows provider → server (not kept) → device.

For pricing: today's table already gates linking to Connected (up to 3 banks). The column above suggests the price argument is **freshness and completeness**, not new kinds of insight: statement users get every insight, connected users get them current and whole. Card linking would add the utilisation and due-date features, which are the clearest Connected-only value. Statement upload stays first-class for every plan, and Private never links: privacy-first users keep the full insight set with nothing leaving the device.

**Bank and card linking (Connected, at launch, opt-in, read-only)**

- **Regulated data network:** connect through Plaid (chosen October 11, 2026; `docs/security/linking.md`), never by scraping. Request only read permissions (transactions, balances, and for cards the liabilities data: statement balance, due date, minimum, credit limit, APR); never account or routing numbers, identity data, or anything that can move money.
- **Per-account choice:** the user picks each account to link; linking a card never links the bank behind it, and one-tap Disconnect is always next to it. Statement upload stays available for any account, linked or not.
- **No password sharing:** the user signs in on their bank's own page where the bank supports it, or inside the provider's secure screen otherwise. Stackd never sees or stores bank usernames or passwords — only a revocable access token.
- **Token handling:** one token per bank connection, encrypted in a managed key vault, server-side only, never in the app. Revoked immediately on Disconnect or account deletion, and automatically after 60 days without opening the app.
- **Encryption:** TLS in transit; AES-256 at rest for the database, files and backups.
- **Pass-through processing:** fetch → apply Stackd rules → return results; raw bank data is not kept on the server. Provider-assigned categories are ignored so results stay deterministic.
- **Public wording** (website security page and in-app link screen) must match what is actually built and get the one-time legal review; avoid absolute claims such as "unhackable".

## Scope, open questions & build order

**Deferred (decide after launch)**

- Brokerage or investment linking of any kind. *(Bank and card linking is no longer deferred: it is part of Connected at launch, Owner decision, October 12, 2026.)*
- Live savings-rate, CD or HSA offers; partner or affiliate links (would add advertising-disclosure obligations).
- Round-ups, auto-transfers between jars, splitting one deposit across jars.
- Native app store submission (Capacitor wrapper).
- Additional looks beyond the six (Minimal, Retro 80s and Illustrative were added October 12, 2026).

**Open questions**

- [x] Final product name and branding: **Qash**, Qash Solutions Inc., `qash.solutions` (owner decisions, October 11–12, 2026).
- [ ] Is on-device/server OCR acceptable under the "no AI" rule, or ship manual-only receipts? *(Built on the device as fast-follow 6, October 10, 2026, as the OCR note describes; a "no" means deleting `features/receipts/ocr/` and the receipt card's button.)*
- [x] Account deletion grace period: deletion finishes within 30 days (owner decision, October 17, 2026). Backup purge timing still open (legal).
- [ ] Which state privacy laws apply; privacy policy and terms written in full and given a one-time legal review (owner decision, October 13, 2026: no retained lawyer).
- [x] OTP limits and the 15% APR "next move" threshold (owner sign-off, October 27, 2026).
- [ ] Educational-content review process and disclaimer wording.

- [x] Jars unlimited on every plan, with limits only on challenges? No: active jars and goals are 2 / 4 / 10 (owner decision, October 10, 2026; signed off October 27, 2026).
- [ ] Phase 3 provider: Plaid chosen for the build (October 11, 2026); per-connection pricing still open.

- [x] Confirm plan contents for Free, Private and Connected (owner sign-off, October 27, 2026); free trial length (3 days on either plan, owner decision October 22, 2026); refund policy beyond deletion (cancelling refunds nothing and the plan runs to the period's end; deletion refunds the unused part: owner decisions, October 17 and 22, 2026). (Founding member cap: the first 250, owner decision October 22, 2026.)
- [ ] Does the FTC Safeguards Rule apply? State automatic-renewal law requirements (legal).
- [x] Native billing: Apple/Google in-app purchase only, or also a US web-checkout link. *Owner decision, October 13, 2026: web only. Subscriptions are sold on the PWA through Stripe, with no store fee. The native apps ship in the US storefronts only and send users to the web checkout at qash.solutions (allowed in the US since the Epic rulings; Apple and Google take 0% on link-outs as of this date, with court proposals pending that could add a fee). The store purchase code from chunk 2.4 stays in the repo, switched off, in case the rules change. Check the current rules in the one-time legal review before submitting the apps.*

- [x] On-device engine: the TypeScript port (decided in chunk 0.6, ADR 0001).
- [x] Backup key recovery: passkey-protected key plus recovery key (owner sign-off, October 27, 2026). Built in chunk 1.16 (October 10, 2026): the key is made on the device, wrapped under a 32-character recovery key (shown once, again on request) and, where the browser supports the WebAuthn PRF extension, under the passkey; restore tries the passkey first, then asks for the recovery key. Also signed off: the newest three backups are kept per user (since October 24, 2026 also the newest of each of the 7 days before, so a burst of bad uploads cannot push out every good copy; a device steps back past a copy its key can't open); turning backup off and replacing the key need step-up and send an always-on email (owner decision, October 24, 2026); household invites last 7 days and are single use; a partner on any plan joins under the Connected owner's plan.
- [ ] Provider quote for Connected's per-bank cost before it goes live.
- [ ] **PDF statements for the launch banks (before the launch gate).** Every PDF still goes through the generic parser: `importers/pdf/templates.ts` `TEMPLATES` is empty until real statements arrive, and a template is never written from a guessed layout. Owner: pick the 3–5 launch-target banks and card issuers, and provide one real PDF statement from each with names and numbers blacked out, so each gets a template and a test fixture. Meanwhile (October 22, 2026) every PDF import says before importing whether its rows add up to the statement's ending balance (from the last running balance, or the printed opening balance plus every row), how many lines it couldn't read, and to check or use a CSV, OFX or QFX when unsure; a printed opening balance also sets the first row's sign.

**Confidence notes**

| Item | Confidence |
|---|---|
| Token-based theming with three looks is feasible | High |
| Deterministic rules in Python with golden tests | High |
| App store deletion and privacy-link requirements | High as of Oct 2026; re-check at submission |
| OCR accuracy on crumpled or faded receipts | Medium; user confirmation required |
| Modern as the best default look | Medium; validate with a small user test |
| Free-plan limits and leaderboard by % of own target | Medium; validate with users |

**Build order****: see Repository structure & delivery phases below**

## Repository structure & delivery phases

One monorepo, delivered in four phases. Each **chunk** is one Claude Code task with a clear "done when". The PWA launches once Phase 1, the website (Phase 1W) and Phase 3 (read-only bank and card linking) clear the launch gate; the native apps (Phase 2) reach the stores after.

**Order:** Phase 0 → Phase 1 + Phase 1W in parallel → fast-follows → Phase 3 (read-only bank and card linking) → launch gate → PWA launch → Phase 2 (native apps in the stores). *Owner decision, October 12, 2026: Phase 3 moved ahead of launch.*

### Build flow

*[Diagram: build flow · 5 phases, 37 chunks, 1 launch gate — see the live spec]*

Phase 1 rows build top to bottom; each box names what must be done first. The website runs alongside Phase 1, and both must clear the launch gate before the PWA ships.

### Top-level tree

```text
stackd/
├── apps/
│   ├── web/                 # PWA — the app (Phase 1)
│   ├── site/                # public website + legal pages (Phase 1W)
│   └── mobile/              # Capacitor iOS + Android wrappers (Phase 2)
├── packages/
│   ├── tokens/              # design tokens → CSS variables + TS types
│   ├── ui/                  # shared React components
│   └── api-client/          # typed client generated from the API's OpenAPI
├── services/
│   ├── api/                 # FastAPI app, DB models, migrations, jobs
│   └── rules/               # stackd_rules: pure, deterministic Python
├── tools/                   # CI guards: AI denylist, contrast, network allowlist
├── docs/                    # spec.md, design-handoff/, security/, decisions/ (ADRs)
├── .github/workflows/
├── docker-compose.yml       # local Postgres, S3-compatible storage, test mail inbox
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

**Tooling (recommended, swappable):** pnpm workspaces + Turborepo for the TypeScript side; `uv` for Python; Vitest and Playwright for web tests; pytest for Python.

**Domains:** website at `[domain]`, app at `app.[domain]`. A separate subdomain keeps the PWA's service worker and install scope isolated from the marketing site.

### Phase 0 — Foundation

Guards, tokens, the rules engine and an empty API — everything later chunks depend on.

```text
.github/workflows/
├── ci.yml                     # lint, typecheck, unit + golden tests
├── guards.yml                 # AI-package denylist, contrast, network allowlist
└── security.yml               # dependency scan, secret scan, authz test suite
tools/
├── check_ai_denylist.py       # fails on openai, anthropic, langchain, etc.
├── denylist.txt
├── check_contrast.ts          # WCAG AA over every look × mode in tokens
└── network_allowlist.txt      # hosts the backend may call (incl. Stripe, push services)
docs/security/
├── SECURITY.md                # owner, reporting address, scope
├── security-plan.md           # written information security plan
├── risk-assessment.md         # reviewed yearly
├── incident-response.md       # roles, breach-notification steps
└── vendors.md                 # hosting, email, push, payments review
packages/tokens/
├── tokens.json                # copied from the design handoff
├── src/build.ts               # → dist/tokens.css (CSS variables) + dist/tokens.ts
└── src/index.ts
services/rules/
├── pyproject.toml
├── stackd_rules/
│   ├── __init__.py            # RULES_VERSION
│   ├── money.py               # integer cents, half-even rounding
│   └── dates.py               # as_of helpers, week, month and payday math
└── tests/
    ├── golden/                # <rule>/<case>.input.json + .expected.json
    └── test_golden.py         # runs every pair; any diff fails CI
services/api/
├── pyproject.toml
├── app/
│   ├── main.py
│   ├── config.py
│   ├── db.py
│   ├── security/
│   │   ├── rate_limit.py      # per-route limits
│   │   ├── audit.py           # audit_log writer
│   │   ├── authz.py           # ownership checks used by every router
│   │   └── step_up.py         # fresh passkey check for sensitive routes
│   └── routers/health.py
├── migrations/                # Alembic
└── tests/
    └── authz/                 # cross-user access tests, grows with each router
docker-compose.yml
```

| Chunk | Builds | Depends on | Done when |
|---|---|---|---|
| 0.1 Repo + CI + guards | root config, `.github/`, `tools/` | — | CI green on empty repo; adding `openai` to any package fails CI |
| 0.2 Tokens | `packages/tokens/` | 0.1 | CSS variables generated for all 3 looks × 2 modes; contrast check passes or lists failures |
| 0.3 Rules skeleton | `services/rules/` | 0.1 | `money.py` + `dates.py` with golden tests; RULES_VERSION exported |
| 0.4 API skeleton | `services/api/`, `docker-compose.yml` | 0.1 | `docker compose up` runs API + Postgres + storage; `/health` returns OK; first migration applies |
| 0.5 Security baseline | `docs/security/`, `app/security/`, `security.yml`, `tests/authz/` | 0.4 | Security owner named; plan and risk assessment drafted; rate limiting, audit log and authz helper in place; scans run in CI |
| 0.6 On-device engine | `apps/web/src/engine/`, `docs/decisions/0001-engine.md` | 0.3 | Pyodide and TypeScript-port prototypes both pass the 0.3 golden tests in a Web Worker; download size and speed measured on a mid-range phone; decision recorded |

### Phase 1 — PWA (launch)

Modern look only. Features are vertical slices: each chunk adds its rule file, API router and screen folder together.

**apps/web**

```text
apps/web/
├── index.html
├── vite.config.ts              # vite-plugin-pwa
├── public/
│   ├── manifest.webmanifest    # theme + background #3D5AFE, standalone
│   └── icons/                  # 512 any, 512 maskable, 192, 180 apple, 32 favicon
├── src/
│   ├── main.tsx
│   ├── app/
│   │   ├── App.tsx
│   │   ├── routes.tsx
│   │   ├── ThemeProvider.tsx   # availableLooks = ["modern"] on web
│   │   ├── EntitlementsProvider.tsx  # plan limits from the server
│   │   ├── SessionLock.tsx     # 5-minute inactivity lock + passkey unlock
│   │   └── layout/
│   │       ├── TabBar.tsx      # phone: Home · Budget · Goals · Insights · Me
│   │       └── SideRail.tsx    # ≥ 900px
│   ├── pwa/
│   │   ├── sw.ts               # caching, offline, update detection, push events
│   │   ├── pushSubscribe.ts    # Web Push subscription (VAPID)
│   │   ├── InstallGuide.tsx    # iPhone sheet + Android/desktop card
│   │   ├── NotifyPrompt.tsx
│   │   ├── OfflineBanner.tsx
│   │   └── UpdateToast.tsx
│   ├── data/                   # the user's money data lives here (local-first)
│   │   ├── db.ts               # IndexedDB (Dexie): every device-side table
│   │   ├── persist.ts          # navigator.storage.persist(), storage estimate, export nudges
│   │   ├── files.ts            # statements + receipt photos kept on the device
│   │   ├── backup/             # E2E encrypt, upload ciphertext, restore, recovery key
│   │   ├── alertSchedule.ts    # computes upcoming alerts, registers date + type only
│   │   ├── serverQueue.ts      # server-bound writes only (groups, alerts, settings)
│   │   └── api.ts              # wraps packages/api-client
│   ├── engine/                 # Web Worker running stackd_rules (Pyodide or TS port)
│   │   ├── worker.ts
│   │   └── bridge.ts           # typed calls: cashflow, forecast, goals, budget…
│   ├── importers/              # on-device parsing, files never uploaded
│   │   ├── csv.ts              # + column mapper
│   │   ├── ofx.ts
│   │   ├── pdf/                # per-institution templates — fast-follow 2
│   │   └── masking.ts          # account numbers → last 4
│   ├── features/
│   │   ├── auth/               # Welcome, SignIn, OtpEntry, useSession
│   │   ├── security/           # PasskeySetup, LockScreen, StepUpPrompt,
│   │   │                       # ManagePasskeys, ActiveDevices
│   │   ├── onboarding/         # pay, pay dates, budget method, first goal
│   │   ├── home/               # HomeScreen, NextMoveCard
│   │   ├── money/              # MoneySummary (In · Out · Net), MonthPicker,
│   │   │                       # CategoryBreakdown, TransactionList, TransactionEdit
│   │   ├── imports/            # UploadStatement, AccountPicker, ColumnMapper,
│   │   │                       # ImportPreview, TransferReview
│   │   ├── forecast/           # UpcomingList, ForecastChart, ShortfallCard, BalanceEntry
│   │   ├── entries/            # AddEntrySheet, EntryList
│   │   ├── receipts/           # ReceiptCapture, ReceiptForm (photos stay on device)
│   │   ├── budget/             # BudgetScreen, RuleView, ZeroBasedView
│   │   ├── goals/              # GoalsList, GoalBuilder, GoalDetail, templates.ts,
│   │   │                       # CustomValueSheet, CadencePicker, MilestoneEditor,
│   │   │                       # MyTemplates, GoalPriority, JarSplit
│   │   ├── groups/             # GroupInvite, JoinGroup, Leaderboard
│   │   ├── household/          # InvitePartner, SharedJars, SharedGoals, LeaveHousehold
│   │   ├── emergency/          # EmergencyScreen
│   │   ├── bills/              # BillsList, RecurringSuggestions, DebtAvalanche
│   │   ├── insights/           # InsightsHub, InsightCard, GrowthCalculator (Learn's articles removed)
│   │   ├── billing/            # PlanPicker (Free · Private · Connected), Paywall,
│   │   │                       # ManagePlan, UpgradeNudge, FoundingOffer
│   │   └── settings/           # SettingsScreen, AccountsManager, BackupSettings,
│   │                           # NotificationSettings, QuietHours, ExportData,
│   │                           # DeleteAccountDialog
│   └── lib/                    # format.ts (cents → display), platform.ts
└── tests/
    ├── unit/                   # Vitest
    ├── engine/                 # runs the shared golden files against the engine
    └── e2e/                    # Playwright
packages/ui/src/                # Button, Card, ListRow, Toggle, ProgressBar,
                                # Chip, Sheet, Toast, SentenceBuilder, TimePicker, index.ts
packages/api-client/            # generated from services/api OpenAPI
```

**services**

```text
services/rules/                 # source of truth for all money math; runs on the device
├── stackd_rules/
│   ├── budget.py               # 50/30/20 and your own split, zero-based, bucket spent
│   ├── cashflow.py             # month In / Out / Net, transfer matching
│   ├── fingerprint.py          # dedupe keys for imported rows
│   ├── categorize.py           # user rules → keyword table
│   ├── recurring.py            # recurring series detection (bills + income)
│   ├── forecast.py             # upcoming list, day-by-day balance, shortfall
│   ├── goals.py                # save, payoff, spend-less, habit, weekly pace
│   ├── goals_custom.py         # cadence, per-period amount, finish date, ongoing, milestones
│   ├── groups.py               # rank by % of own target
│   ├── emergency.py            # runway, ETA
│   ├── bills.py                # bills list, avalanche order
│   ├── growth.py               # Later's savings projection
│   ├── next_move.py            # fixed priority list + goal priority
│   ├── alerts.py               # which alerts are due (device side)
│   └── config/
│       ├── next_move.yaml
│       └── keywords.yaml       # default merchant keyword → category table
└── tests/golden/               # shared by the server tests and apps/web/tests/engine
services/api/app/               # thin server: no money data stored in readable form
├── models/                     # user, session, webauthn_credential, subscription,
│                               # entitlement, group, group_member, goal_template (shared),
│                               # notification_pref, notification_settings,
│                               # push_subscription, notification_log, alert_schedule,
│                               # backup, audit_log
├── rules_server/
│   ├── notify.py               # quiet hours, daily max, dedupe; security alerts always on
│   ├── entitlements.py         # plan → limits, downgrade handling
│   └── plans.yaml              # free / private / connected limits and prices
├── routers/                    # auth, security, groups, alerts, notifications, billing,
│                               # backup, settings, account
├── services/                   # otp, email, webauthn, security_alerts, push (Web Push now;
│                               # APNs/FCM in Phase 2), stripe_billing, backup_store
│                               # (ciphertext only), deletion
├── webhooks/                   # stripe.py (signature verified); apple.py, google.py in Phase 2
└── jobs/                       # alert_dispatch (scheduled pushes), weekly_recap,
                                # downgrade_notice, account_delete, backup_purge
```

| Chunk | Builds | Depends on | Done when | Scope |
|---|---|---|---|---|
| 1.1 App shell | `app/`, `layout/`, `packages/ui` core, manifest, icons | 0.2 | Tab bar on phones and a responsive single column on wider screens, in Modern light, dark and Simple layout; app is installable | Launch |
| 1.2 Auth + passkeys | `features/auth`, `features/security`, SessionLock, routers/auth + security, services/otp, email, webauthn, security_alerts, step_up.py | 0.4, 0.5, 1.1 | Sign-up requires email code + passkey; 5-minute auto-lock and step-up checks work; devices listed and revocable; always-on security alerts sent | Launch |
| 1.3 Local store + entries | `data/db.ts`, `persist.ts`, `features/entries`, `engine/` wiring | 1.2, 0.6 | Manual entries live only in IndexedDB; persistent storage requested; engine answers from the device | Launch |
| 1.3b Statement import | `importers/`, `features/imports`, `files.ts` | 1.3 | CSV + OFX/QFX parsed on the device (PDF is fast-follow 2); nothing uploaded (verified by network test); re-upload creates no duplicates; numbers masked | Launch |
| 1.3c Money in & out | `cashflow.py`, `features/money` | 1.3b | Month In, Out and Net match golden tests from sample statements; transfers never double-count | Launch |
| 1.4 Budget | `budget.py`, `features/budget` | 1.3c | Golden tests pass for both methods | Launch |
| 1.5 Goals | `goals.py`, `features/goals` core, SentenceBuilder | 1.3 | All 4 kinds; weekly pace matches golden tests | Launch |
| 1.5b Custom goals + jars | `goals_custom.py`, CustomValueSheet, CadencePicker, MilestoneEditor, MyTemplates, GoalPriority, JarSplit | 1.5 | Custom name, amount and date in the goal sentence; basic jars pass golden tests (extras are fast-follow 3) | Launch |
| 1.6 Groups | `groups.py`, `features/groups`, routers/groups | 1.5 | Monthly savings challenge (each saves toward their own target for the month); join by code or link; only % progress leaves the device; leaderboard never shows dollars | Launch |
| 1.7 Upcoming + forecast | `recurring.py`, `forecast.py`, `features/forecast`, `features/bills` | 1.3c | Recurring suggestions confirmable; 30-day list; shortfall date and amount match golden tests | Launch |
| 1.8 Home | `features/home`, `next_move.py` | 1.4–1.7 | In · Out · Net; shortfall overrides the next-move card | Launch |
| 1.9 Receipts | `features/receipts`, `files.ts` | 1.3 | Photos stored only on the device; EXIF stripped; retention setting works locally | Launch; OCR fast-follow |
| 1.10 Bills list, Learn, emergency fund as a jar | `emergency.py`, `bills.py`, `growth.py`, matching features | 1.7 | Golden tests pass; at least 3 reviewed articles *(October 18, 2026: the articles were removed and Learn became Insights)* | Launch |
| 1.11 Settings + data rights | `features/settings`, AccountsManager, ExportData, DeleteAccountDialog, routers/account | 1.2 | Export built on the device; deletion removes server data, local data and backups | Launch |
| 1.12 PWA extras | `pwa/` install, offline, update | 1.1 | Install guide (iPhone + Android), offline banner, update toast work | Launch |
| 1.13 Notifications | `alerts.py`, `alertSchedule.ts`, `pushSubscribe.ts`, NotificationSettings, QuietHours, routers/alerts + notifications, rules_server/notify.py, jobs/alert_dispatch | 1.7, 1.12 | Device registers date + type only; pushes arrive on time with no amounts or merchants in the payload; quiet hours, daily max and dedupe pass golden tests | Launch |
| 1.14 Plans & billing | `entitlements.py`, `plans.yaml`, `features/billing`, routers/billing, services/stripe_billing, webhooks/stripe | 1.5b, 1.3b | Free, Private ($1.99/mo annual or $3 monthly), Connected with couples, and the $150 Founding member offer (one-time, 4 years); Stripe Checkout and Portal work; limits enforced on the server | Launch |
| 1.16 Encrypted sync + couples | `data/backup/`, BackupSettings, routers/backup, services/backup_store, jobs/backup_purge, `features/household`, routers/household, household key exchange | 1.3, 1.14 | Two devices stay in sync with ciphertext-only server storage; a partner joins by invite link; shared jars and goals are end-to-end encrypted with the household key; leaving splits shared jars by contributions | Launch |
| 1.15 Hardening | `tests/e2e`, `tests/engine`, authz suite, accessibility, pen test fixes | all | WCAG AA passes; cross-user tests pass; network tests prove statements, receipts and transactions never leave the device unencrypted; pen test fixed | Launch |

**Fastest launch:** ship the "Launch" scope, then the fast-follows (the six fast-follows listed in Launch scope, in that order) in the weeks after. Confidence medium: this cut keeps the core loop intact, but validate it against what early users ask for.

### Phase 1W — Website (parallel with Phase 1)

A static, fast-loading public site in the Modern look. It must be live before the PWA launches, because the privacy policy, terms and the public account-deletion page are required links. Recommended: Astro (static HTML, good for search, reuses `packages/tokens`). Confidence medium-high; any static-site tool works.

```text
apps/site/
├── astro.config.mjs
├── src/
│   ├── layouts/
│   │   └── Base.astro            # header, footer, tokens.css (Modern)
│   ├── components/               # Header, Footer, Feature, Screenshot, FAQItem, PlanCard
│   ├── pages/
│   │   ├── index.astro           # landing: what it does, screenshots, "Open the app"
│   │   ├── how-it-works.astro    # money in & out, statement upload, forecast, goals
│   │   ├── pricing.astro         # Free / Private / Connected + Founding offer, renewal + cancel terms
│   │   ├── security.astro        # plain-language security and "data we never collect"
│   │   ├── privacy.astro         # policy text (full sections shown once written)
│   │   ├── terms.astro           # terms + subscription terms (full sections shown once written)
│   │   ├── delete-account.astro  # public deletion request form (Google Play rule)
│   │   ├── support.astro         # FAQ + contact
│   │   └── 404.astro
│   └── content/
│       └── faq/*.md
└── public/
    ├── og-image.png
    ├── favicon.ico
    ├── .well-known/security.txt  # how to report a vulnerability
    └── screenshots/              # from the design handoff previews
```

| Chunk | Builds | Depends on | Done when |
|---|---|---|---|
| W.1 Site shell + landing | layouts, components, `index`, `how-it-works`, `404` | 0.2 | Lighthouse performance and accessibility ≥ 90; "Open the app" links to `app.[domain]` |
| W.2 Legal, pricing + support | `privacy`, `terms`, `pricing`, `security`, `support`, FAQ, `security.txt` | W.1 + the full legal text | Pages live; linked from the PWA's Settings and plan picker; pricing matches `plans.yaml` |
| W.3 Public account deletion | `delete-account` + API endpoint that emails a confirm code | W.1, 1.2 | Request by email code deletes the account through the same job as in-app deletion |

### Phase 2 — Native iOS and Android (after PWA launch)

The same `apps/web` build wrapped by Capacitor. New code is mostly native bridges, bundled fonts and store assets; screens are reused.

```text
apps/mobile/
├── capacitor.config.ts         # webDir: ../web/dist
├── ios/                        # generated Xcode project
├── android/                    # generated Gradle project
├── assets/                     # app icons + launch screens per platform
└── store/
    ├── ios/                    # App Store text, screenshots, privacy labels,
    │                           # subscription products (Private, Connected)
    └── android/                # Play listing, screenshots, Data safety answers,
                                # subscription products (Private, Connected)
apps/web/src/native/            # bridges, loaded only when isNativePlatform()
├── biometrics.ts               # Face ID / fingerprint sign-in
├── camera.ts                   # receipt capture
├── push.ts                     # APNs / FCM registration → push_subscriptions
├── purchases.ts                # Apple IAP / Google Play Billing → entitlements
└── widget/                     # home-screen widget (Swift / Kotlin)
apps/web/src/app/ThemeProvider.tsx   # availableLooks adds pastel + anime when native
packages/tokens/fonts/               # Sora, Plus Jakarta Sans, Dela Gothic One,
                                     # M PLUS Rounded 1c, DotGothic16 (bundled)
services/api/app/webhooks/           # apple.py (App Store Server Notifications),
                                     # google.py (Real-time developer notifications)
```

| Chunk | Builds | Depends on | Done when |
|---|---|---|---|
| 2.1 Wrappers | `apps/mobile/` shells, icons, launch screens | PWA launched | App runs on iOS and Android test devices from the same web build *Built October 10, 2026 up to the device step: `apps/mobile/` (Capacitor 8, `capacitor.config.ts` with `webDir: ../web/dist`, the generated `android/` and `ios/` projects with Swift Package Manager, icons and launch screens rendered from the PWA's mark by `scripts/assets.ts`, `pnpm -C apps/mobile sync`), CI assembles both shells from the web build on every PR, and `data/api.ts` calls the API at `https://<app host>` inside a shell. Running on test devices needs Xcode and Android Studio, which this machine does not have; the README has the steps. The app id `com.stackd.app` and the host are placeholders until `[domain]` and `[Company legal name]` are decided.* |
| 2.2 Three looks | ThemeProvider native rule, bundled fonts, Settings picker | 2.1 | Modern, Pastel and Anime switch instantly; all 6 combinations pass contrast; PWA never overwrites the saved look *Built October 10, 2026: `ThemeProvider` keeps the look as state in a native app (the device's cached choice for the first paint, then the account's `users.look` when the session arrives through `LookSync`; `setLook` applies at once), the Settings → App look card offers Modern · Pastel · Anime there and saves the pick with `PATCH /api/account {look}`; the PWA keeps `availableLooks = ["modern"]`, ignores the saved look and never writes it. Fonts: Sora, Plus Jakarta Sans, Dela Gothic One, M PLUS Rounded 1c and DotGothic16 come from pinned `@fontsource` packages in `apps/web` (latin subsets, `font-display: swap`) as dynamic imports in `app/lookFonts.ts`, so they ship inside the native bundle, are loaded only for the active look, and are excluded from the PWA's precache; they are not a separate `packages/tokens/fonts/` folder. Contrast for all six look × mode pairs was already in CI (`tools/check_contrast.ts`).* |
| 2.3 Native features | `biometrics.ts`, `camera.ts`, `push.ts`, `widget/` | 2.1 | Face ID sign-in, camera receipts, native push with the same preferences, and a widget work on both platforms *Built October 11, 2026 up to the device step: `apps/web/src/native/` holds the four bridges, each a no-op in a browser (`lib/platform.nativePlugin`). Camera receipts go through the shell's Camera plugin into the same metadata strip; push registration sends only a platform and an APNs / FCM device token to `POST /api/notifications/push/native` (stored encrypted; `services/push_native.py` delivers through APNs — HTTP/2, ES256 JWT, sandbox by default — and FCM v1 — service-account OAuth — with the same generic labels, quiet hours and dedupe as Web Push, off per platform without credentials); passkey ceremonies route through a `StackdPasskeys` plugin and Home hands a `StackdWidget` plugin its display strings, with both plugin contracts in apps/mobile/README.md because their Swift / Kotlin halves need Xcode / Android Studio, absent on this machine, as do the push capability, google-services.json and the widget targets. Fixing dispatch along the way: notification dedupe is now per user (migration 0010), since device keys like `recap:<date>` are the same string for everyone.* |
| 2.4 Native billing | `purchases.ts`, store subscription products, `webhooks/apple.py`, `webhooks/google.py` | 2.1, 1.14 | Buying, renewing, cancelling and restoring work on both stores; one entitlement record per user across web and native *Built October 11, 2026 up to the device step: `native/purchases.ts` runs the OS payment sheet through a `StackdPurchases` plugin (contract in apps/mobile/README.md; the StoreKit 2 / Play Billing halves need Xcode / Android Studio) with the user id as the account token, and syncs the store's proof to `POST /api/billing/native/sync`; `services/native_billing.py` verifies an Apple transaction JWS against the bundled, pinned Apple Root CA G3 and a Play purchase token against the Play Developer API (service account; token hashed into `external_id`), writing the same `subscriptions` rows as Stripe so the newest live one wins across web and native. `webhooks/apple.py` (App Store Server Notifications V2, chain-verified, once per notificationUUID) and `webhooks/google.py` (RTDN as a hint only: the token is re-verified against the API) keep renewals, cancellations and expiry current. Store product ids live in `plans.yaml` `store_products` and ride on `GET /api/billing`; the Plan screen buys and manages through the store inside a shell, restores purchases, and keeps Founding web-only (no 4-year term in the stores). The store products themselves are created in the consoles at 2.5.* |
| 2.5 Store submission | `store/` listings, privacy labels, Data safety form | 2.2–2.4, W.3 | Both apps submitted; account deletion reachable in-app and on the web; subscription terms shown before purchase *October 11, 2026: the `apps/mobile/store/` artifacts are written from the real data flows — both listings, the Apple privacy labels and the Play Data safety answers (money data not collected: device-only, backup end-to-end encrypted; collected and linked: email, optional display name, user id + push token, plan, group percentage; no tracking or analytics; the hashed-IP audit log flagged for the legal review) — with the human steps left in `store/README.md`: developer accounts, `[Name]` / `[domain]`, the four subscription products (plans.yaml ids), webhook endpoints, screenshots, Apple review's OTP sign-in question, the legal review, submission itself. Deletion in-app and on the web and the pre-purchase terms were already live.* |

### Phase 3 — Read-only bank and card linking (Connected; before launch)

Part of Connected from launch (Owner decision, October 12, 2026), opt-in per account. Free and Private never link; statement upload and manual entry stay available to everyone. Production needs Plaid's approval and the one-time legal review of the public wording; until then linking runs against the Plaid sandbox and is off without its settings.

```text
services/api/app/
├── linking/
│   ├── plaid.py               # Link token, token exchange, /transactions/sync
│   ├── token_vault.py         # encrypt/decrypt access tokens via the key vault
│   └── normalize.py           # provider rows → entries (provider categories ignored)
├── routers/linking.py         # start link, finish link, disconnect, sync now
├── webhooks/linking.py        # provider update webhooks (signature verified)
└── jobs/
    ├── linked_sync.py         # pull → pass to the device → not kept
    └── dormant_revoke.py      # revoke tokens after 60 days without opening the app
apps/web/src/features/linking/ # ConnectBank, LinkedAccounts, DisconnectDialog
docs/security/linking.md       # scopes, token handling, provider review
```

| Chunk | Builds | Depends on | Done when |
|---|---|---|---|
| 3.1 Provider decision | `docs/security/linking.md`, quotes, contract | 0.5 | Provider chosen; per-connection cost fits the plan price; legal review of the public wording *October 11, 2026: Plaid chosen for the build (Transactions + Liabilities, sandbox); `docs/security/linking.md` drafted. Plaid's quote, and production approval are still open.* |
| 3.2 Link + vault | `linking/`, `routers/linking.py`, `features/linking` | 3.1, 0.5 | Bank linked through the provider's screen; read-only scopes; token encrypted server-side; step-up check required *October 11, 2026: built against the Plaid sandbox. Hosted Link (no provider script in the app), Transactions with Liabilities optional, the access token sealed under its own key, step-up before start, the plan's cap enforced, the shared accounts returned to the device and not kept; Disconnect revokes at Plaid then deletes. Off without the `STACKD_PLAID_*` settings until 3.1 is signed.* |
| 3.3 Sync + normalize | `linked_sync.py`, `normalize.py`, `webhooks/linking.py` | 3.2, 1.3c | Linked transactions flow into Money in & out and the forecast through the same fingerprint, transfer and category rules; no duplicates with uploads *October 12, 2026: built against the Plaid fake. `POST /api/linking/{id}/sync` passes `/transactions/sync` through (cursor from the device, slim rows, categories dropped, nothing kept; `plaid.transactions_sync` restarts once on a mid-pagination change); `POST /api/webhooks/plaid` verifies Plaid's ES256 JWT and body hash and only flags the connection (migration 0012: status, last_synced_at, updates_available_at). On the device `features/linking/sync.ts` masks, fingerprints, categorises (the shared `loadCategorizer`) and pairs transfer-hinted rows through `cashflow.match_transfers`; an uploaded entry with the same fingerprint, or the same day, amount and direction in the account, is adopted rather than duplicated; pending rows are replaced when posted; balances become `linked` anchors (a card's as owed, negative); entries are `lnk-<provider id>` so devices merge through the backup; the cursor is saved with the rows. `LinkedSync` pulls on open, on focus and every 15 minutes (owner sign-off, October 27, 2026), only on a device with a linked account. Live sandbox run still pending the Plaid secret.* |
| 3.4 Revoke + alerts | `dormant_revoke.py`, Disconnect, security alerts | 3.2 | Disconnect, account deletion and 60-day dormancy all revoke tokens; connect and disconnect alerts sent *October 12, 2026: built. `jobs/link_revoke.py` (`stackd-api revoke-links`, daily) retries `revoke_pending` connections and every connection of a deleted account, and revokes live ones unused for `STACKD_LINK_DORMANT_DAYS` (60) with audit `bank_auto_revoked` and an always-on email; opening the app counts as use: the pull it makes on open (`POST /api/linking/{id}/sync`, also when the bank asks the person to sign in again), a card read, a finish or a relink; `GET /api/linking` writes nothing, since a cross-site GET carries the session cookie (October 28, 2026). Disconnect never fails for the user: if Plaid is down the row becomes `revoke_pending`, hidden and retried. `deletion.purge_due` keeps an account until its tokens are revoked. "Sign in again": `POST /api/linking/{id}/relink` opens Plaid's update mode (`link_sessions.connection_id`, migration 0014) and `/finish` repairs the connection after reading it again. The device unlinks accounts whose connection the server no longer lists, keeping their entries.* |
| 3.5 Card details (owner decision, Oct 11, 2026) | the provider's liabilities data in `normalize.py`; the card utilisation line and pay-in-full-by-due-date reminders (both from the parking lot) | 3.3 | A linked card shows its statement balance, due date, minimum, credit limit and APR; utilisation and the due-date reminder use only those, read-only, nothing moves money; the same per-account choice and pass-through rules as banks  *October 12, 2026: built. API `POST /api/linking/{id}/cards` passes Plaid `/liabilities/get` through (statement balance, statement and due dates, minimum, last payment, limit from the account balances, the purchase APR; nothing stored; an item without card data answers empty); rules `credit.utilization_bps` and `credit.pay_in_full` (RULES_VERSION 0.19.0); the device keeps the facts in `card_details` (Dexie v13, in the export, not in backups), refreshed after each sync; Bills → Debt payoff shows Your cards (balance, due countdown, limit used, minimum, limit, APR, the plan and its payday split); the due date joins the reminder schedule as an upcoming bill (`card-<account>`); a statement paid in full is the `card_paid` moment.* |
