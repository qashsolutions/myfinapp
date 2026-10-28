# @stackd/web

The Stackd PWA. React + Vite + `vite-plugin-pwa`, Modern look only on the web, local-first (chunk 1.3 onward keeps every money record in IndexedDB on the device).

Chunk 1.1 (app shell): installable manifest and icons, service worker that precaches the shell, theme provider (light / dark / Match system, Simple layout), the five-tab bar on phones and the side rail from 600px, the global + button, shared components from `@stackd/ui`, and placeholder screens that later chunks fill in. The Me tab's Display section is real.

Chunk 1.2 (auth + passkeys): Welcome, email code, the mandatory passkey, the 5-minute lock screen, the step-up sheet, and Me → Security & backup (passkeys, signed-in devices). All of it talks to `services/api` through `@stackd/api-client`; in development Vite proxies `/api` to `http://127.0.0.1:8000`.

Chunk 1.3 (local store + entries): the device database (Dexie, one per user), persistent-storage request, the rules engine in a Web Worker, and manual entries: the Add entry form from the + button, the entries list by month, recent entries on Home, and the storage line on Me. Entries never leave the device.

Chunk 1.3b (statement import): CSV and OFX/QFX parsed on the device (`src/importers/`), the three-step import flow (`src/features/imports/`: file + account, match columns, review with transfer questions), duplicate rows skipped by fingerprint, account numbers masked, the file kept on the device only if the user says so. The + button now opens a chooser: entry, statement, receipt (1.9).

Chunk 1.3c (Money in & out): `/money` with the month's In, Out and Kept from the `cashflow` rule, the comparison with last month, the transfers-excluded note, categories and transactions tabs; transfer and split in the entry editor; the Home hero is this month's Kept. Results are stored in `computed_results` with their rules version.

Chunk 1.4 (Budget): take-home pay and budget style setup (from the F2 mockups), the 50/30/20 bucket cards and the zero-based lines (F5Budget), the over-plan insight, "Edit take-home" and "Change budget style", the month carried forward, and the Home tile's status. Numbers come from the `budget` rule.

Chunk 1.5 (Goals): the Goals tab with jars as cards, the sentence builder (`/goals/new`: Save / Pay off / Spend less / Habit, blanks filled from preset sheets, the weekly pace shown before you create), and the goal screen (`/goals/:id`: progress ring, log a deposit or update a balance or check in for the day, recent events, remove). Progress comes from the `goals` rule; money logged here never moves anywhere. 

Chunk 1.5b (Custom goals + jars): every name, amount and deadline blank in the sentence also takes your own value ("Or name your own", "Or any amount", "Or pick a date" in `CustomValueSheet`), checked by the `goals_custom.jar` rule before the sheet closes: a name up to 10 characters, any amount above zero, any date from today on or no deadline. Cadence, milestones, why lines, templates, priority and jar split are fast-follow 3.

Chunk 1.6 (Groups): the Challenges half of the Goals tab. Start a monthly savings challenge (`/groups/new`), join one by invite code or share link (`/groups/join?code=STK-XXXX`), and the challenge screen (`/groups/:id`) with your own progress, the leaderboard ordered by percent of each person's own target (`groups.rank` in the engine), an invite sheet (copy code, share link, owner issues a new code), remove members (owner) and leave. Your target is a private jar on this device; the server only ever receives your percentage, and only after your first deposit.

Chunk 1.7 (Upcoming + forecast): `/forecast` ("Next 30 days": the shortfall warning, the estimated balance chart with your safety buffer and lowest point, "How we calculated this", and the list of expected bills and income), `/bills` (payees that look recurring in your statements to confirm or dismiss, confirmed bills and expected income, add or edit by hand; the debt payoff tab is fast-follow 1), and Home's Next 30 days card. Numbers come from the `recurring` and `forecast` rules; the starting balance is your latest statement's ending balance or one you enter.

Chunk 1.8 (Home): the top of Home answers two questions. "Got · Spent · Kept" with a one-line verdict ("You spent less than you got" or "You spent $X more than you got") and a spend meter; "Set aside $X of $Y this month" against the budget's save target, with how many paydays had a deposit. Then the next move: on payday, "Set aside $X before it goes" with one tap that logs a jar deposit; otherwise the starter fund, a bill due soon, or a goal to start. A forecast shortfall replaces that card. The order and thresholds come from `next_move.yaml` in the rules package.

Chunk 1.9 (Receipts): "+ → A receipt" opens Add entry with the receipt card; a photo from the camera or library is stripped of its metadata (EXIF, XMP, comments, PNG text and time chunks) on the device before it is stored, and attached to the entry on save. Me → Receipt photos sets how long photos stay (90 days, 1 year, forever); expired photos are removed the next time the app opens and the entry keeps its amount. "Read text from photo" is fast-follow 6.

Chunk 1.10 (Bills list, Learn, emergency fund as a jar): the Emergency fund jar's screen gains runway if income stopped, a 3- or 6-month target, the starter / one-month / target milestones and when your monthly plan gets there (essentials prefilled from Budget's needs). Bills → Debt payoff lists cards and loans by highest APR with the minimums and balances totalled; extra payments go to the top one. Learn has the growth calculator (an illustration at the rate you type) and eight short explainers, each ending with the education disclaimer.

Chunk 1.11 (Settings + data rights): the Me tab in the spec's order. Edit your name; change your email with a code to the new address; Accounts & imports (`/me/accounts`: balances, last import, set a balance, add or remove an account with its transactions, your category rules); Download all my data (a ZIP built on this device: profile, entries CSV, goals, groups, budgets, settings, receipt photos; the server adds only your account and groups after a passkey check); Delete all receipt photos; Privacy & legal; Delete account (`/me/delete`, two taps from Me: what goes, export first, type DELETE, a passkey check, then this device wipes its copy and the server removes the account after the grace period).

Chunk 1.12 (PWA extras): the install guide (iPhone: Share → Add to Home Screen; Android and desktop: the browser's install dialog) offered after the second visit, from Me → Install Stackd, and never inside the installed app; "Not now" hides it for 14 days. The offline banner says changes stay on the device and shows how many are waiting to sync; the queue flushes when the connection returns. A new version waits for "Refresh" in the update toast.

Chunk 1.13 (Notifications): Me → Notifications → Alerts: push on or off for this device (the "Stay on track" explainer comes before the browser's permission dialog; on iPhone the app must be on the Home Screen first), one switch per alert type with its options, quiet hours, most per day, pause all. The device works out which alerts are due from its own data and registers only dates, types and dedupe keys; the server sends a fixed generic line ("An expected expense is coming up") and the app shows the details when opened.

Fast-follows 7 and 8 (category rules, insights): imports take categories from your own rules, then the keyword table, and leave everything else uncategorized for you to sort (the bundled learned model was removed on October 28, 2026: no AI in the code); changing an entry's category offers "Always put … in …", which also fixes past uncategorized matches. Next 30 days and Home show how much is safe to spend until payday beyond your usual spending, and Next 30 days lists bigger months ahead: bills that come every 3 months or yearly with an amount to set aside each month, and months that ran high last year. Money in & out shows categories running higher than usual and spending by account. Bills → Debt payoff has a calculator comparing your debts as they are with moving them to an offer you type in, with no lender named and no recommendation.

Phase 2, chunk 2.4 (native billing): inside the apps, choosing a plan opens the store's own payment sheet and the server verifies the store's signed proof before the plan changes; managing, switching and cancelling live on the App Store / Google Play subscription page, Restore purchases brings a plan back after a reinstall, and the Founding offer stays on the website (the stores have no 4-year term). One plan record follows the account across web and native.

Phase 2, chunk 2.3 (native features): inside the shells, the receipt card's "Add a receipt photo" opens the system camera or library and the photo goes through the same metadata strip; turning notifications on registers the device for APNs or FCM (only a platform and a token leave the device, and the same preferences, quiet hours and generic labels apply); passkey prompts use Face ID or the fingerprint through the shell's plugin; and Home keeps a home-screen widget's numbers current. In a browser none of this changes anything.

Phase 2, chunk 2.2 (three looks): inside the iOS and Android apps, Me → App look offers Modern, Pastel and Anime; the switch is instant, the look's fonts load from the bundle, and the choice is saved to the account so every device agrees. In a browser the card says the other looks live in the apps, and the PWA keeps rendering Modern without ever changing the saved look.

Phase 2, chunk 2.1 (native shells): `apps/mobile` wraps this build with Capacitor; inside a shell `data/api.ts` calls the API at `https://<app host>` and everything else is unchanged, because nothing here assumes a shell (`lib/platform.ts` is the one place that notices one).

Fast-follow 6 (weekly recap, receipt text): `/recap` is "Your week": the seven days ending today as Got · Spent · Kept, how that compares with the week before, where it went, what went into jars, and a link to the next 30 days; every number is computed on this device and stored with the rules version. The weekly recap alert can arrive by push, email or both (Me → Notifications → Weekly recap → Options → Send as); the email only says the recap is ready and links here. On the receipt card, "Read text from photo" reads the photo on this device (Tesseract.js served by the app from `public/ocr`; nothing is uploaded) and suggests the merchant, date and total for you to check; "Use these" fills the form, and the text stays with the receipt.

Fast-follow 5 (desktop two-pane layout): from 900px wide the main column widens and Home becomes a dashboard: the date and a greeting by name, the month's numbers, the next move, the forecast and the tiles on the left, recent entries on the right; Goals shows jars and challenges side by side with no tab to switch; the side rail shows who is signed in. Between 600 and 899px the rail stays and everything is one column, as before; Simple layout is always one column.

Fast-follow 4 (more challenge types): Start a challenge now offers five types: Monthly savings, No-Eat-Out Week (seven daily check-ins from a start date), Dining diet (spend less on dining this month than you usually do; you enter your usual spend and how much to keep back), No-spend weekend (two check-ins from a Saturday) and 52-week saving (your own total over a year, the classic $1,378 by default). Each member's own goal is built on their device from the type; the board still shows names and percentages only, habits by days checked in and the diet by the share kept back.

Fast-follow 3 (custom-goal extras): a jar's sentence gains "every week / every 2 weeks / every month / every paycheck" and the builder shows the amount each time and the finish date from the engine (or, with no end, an ongoing jar that counts a streak). Jars take a why line and quarter milestones (25 / 50 / 75%), each cheered on the jar's screen and reported to alerts when reached. The jar's screen can pause and resume (alerts stop, the streak holds), move money to another jar (a withdrawal here, a deposit there) and save the jar as a template for next time; My templates appear in the builder. The Goals tab reorders jars, and Home's next move points at the top jar that is behind its pace. Sharing a template to a group as a challenge comes with more challenge types.

Fast-follow 2 (PDF statements): the import's first step also takes a PDF. The text layer is read on the device (pdf.js through `unpdf`, no upload, no rendering), lines are rebuilt from their positions, and a template reads the transactions: the common "date, description, amount, balance" layout works for any bank, with the sign taken from the running balance; per-bank templates slot in ahead of it as the launch list is decided. Column matching is skipped, the account's last four digits and the statement period are picked up, and the import records which template read the file. Scanned images (no text layer) and unknown layouts get a clear message to download a CSV or OFX instead.

Fast-follow 1 (debt payoff planner, emergency fund screen): Bills → Debt payoff gains the Payoff plan card: pick an extra amount on top of the minimums (or type one) and see the debt-free month, the months and interest, what the extra saves against minimums only, each debt's payoff month and a line of the balance falling to zero, all from the `bills.payoff_plan` rule; when the minimums cannot catch the interest it says so. `/emergency` is the emergency fund's own screen, reached from Home's starter-fund and runway cards: it creates the "Emergency fund" jar if there is none and shows the runway, target, milestones and plan, with a way into the jar to log a deposit.

Links to the website (`/privacy`, `/terms`, `/licenses`, chunk 1W) are built from `VITE_SITE_URL` at build time (`lib/brand.ts`); set it to the site's origin when deploying.

Chunk 1.16 (Encrypted sync + couples): Me → Security & backup → Encrypted backup (Private and Connected): turn it on and a key is made on this device; the recovery key (eight groups of four letters) is shown once and again on request; every backup is encrypted here before upload, we keep only scrambled data and wrapped copies of the key we cannot open. A new device signs in, then unlocks the backup with its passkey (where the browser supports the PRF extension) or the recovery key, and the data merges in; from then on devices stay in step on open, on reconnect and every few minutes, newest change winning and deletions remembered. Turning it off deletes the backup from our servers and keeps everything on the device. Me → Couples & household (Connected): an invite link that carries the household key after `#` (never sent to us); your partner joins from it; jars you choose to share show who added what, the month's In and Out can be shared as totals only, and leaving keeps each person's own deposits.

Chunk 1.14 (Plans & billing): Me → Plan → Your plan (`/me/plan`): the current plan with its renewal line ("$23.88 a year · renews Oct 9, 2027", or "ends …, then Free" after a cancellation), Switch to monthly / yearly, Receipts & invoices and Cancel plan (the "If you cancel" sheet, then Stripe's Customer Portal), and the picker: Free, Private, Connected with a yearly / monthly toggle, plus the $150 Founding member offer (4 years of Connected, no renewal). Price, renewal terms and how to cancel are on the screen before anything is bought; a passkey check comes before either Stripe page, and card details never touch this app. The plan's limits (`features/billing/entitlements.ts`, from the server's `plans.yaml`, cached on the device for offline use) gate the goal builder (2 / 4 / 10 active jars and goals; extras after a downgrade stay, read-only), the import account picker (statements for 1 account on Free) and challenges (Free joins one at a time; starting needs Private or Connected). Nothing is deleted on a downgrade.

## Commands

```bash
pnpm -C packages/tokens build   # once: tokens.css that base.css imports (turbo does this for test/build)
pnpm -C apps/web dev            # http://localhost:5173 (sign-in needs the API: cd services/api && uv run uvicorn app.main:app --port 8000)
pnpm -C apps/web test           # Vitest + jsdom + Testing Library
pnpm -C apps/web typecheck
pnpm -C apps/web build          # dist/ with manifest.webmanifest, sw.js, precache list
pnpm -C apps/web preview        # serve dist/ at http://localhost:4173 (service worker + install work here)
pnpm -C apps/web icons          # re-render public/icons/*.png from scripts/icons.ts
```

From the repo root, `pnpm dev` builds the tokens and starts the dev server.

## Layout

| Path | Role |
|---|---|
| `index.html` | Viewport, icons, theme-color meta, and a tiny pre-paint script that applies the saved mode and layout before React loads. |
| `src/main.tsx` | Fonts (Outfit 400–700, self-hosted via `@fontsource/outfit`), base CSS, service-worker registration, render. |
| `src/app/App.tsx`, `routes.tsx`, `tabs.ts` | Providers, router, the five tabs in order. `tabs.ts` holds paths and labels only; both navigations read it. |
| `src/app/ThemeProvider.tsx` | `useTheme()`: look (always Modern on web), mode setting and resolved mode, Simple layout. Sets `data-look`, `data-mode`, `data-simple` on `<html>`; persists to `localStorage` (`stackd.mode`, `stackd.simple`). |
| `src/app/layout/` | `AppShell` (skip link, one primary nav, focus to `<main>` on navigation), `TabBar` (phones), `SideRail` (≥ 600px), `ScreenHeader` with the global `AddButton`, `Logo`, `shell.css`. |
| `src/pwa/manifest.ts`, `sw.ts` | Manifest per spec (`#3D5AFE`, standalone, 512 any + maskable, 192). Workbox precache; chunk 1.12 adds the update prompt, offline banner and push. |
| `src/lib/` | `platform.ts` (`isNativePlatform`, `isStandalone`, `prefersReducedMotion`), `useMediaQuery.ts`. |
| `src/features/*` | One folder per feature. `auth/`, `security/`, `entries/`, `imports/`, `money/` (MoneyScreen, MonthPicker, MoneySummary, CategoryBreakdown, TransactionList, useMonthTotals), `budget/` (BudgetScreen, BudgetSetup, RuleView, ZeroBasedView, useBudget) and `settings/` are live; the rest are placeholders. |
| `src/app/RequireAuth.tsx`, `SessionLock.tsx` | The gate around the app routes (signed in with a passkey, else Welcome or passkey setup) and the inactivity lock. |
| `src/data/api.ts` | The one API client (same origin, cookies, auth signals broadcast to the session store). |
| `src/data/db.ts`, `defaults.ts`, `persist.ts`, `DbProvider.tsx` | The device database and everything about keeping it: per-user Dexie schema, default categories and account, `navigator.storage.persist()`, storage estimate, export nudge. |
| `src/engine/worker.ts`, `bridge.ts` | `@stackd/rules` in a Web Worker, with typed wrappers (`parseAmount`, `monthBounds`, `addMonths`) and an inline fallback; `engine.call("fingerprint.row", …)` and `"categorize.match"` are used by the import. |
| `src/importers/`, `src/data/files.ts` | CSV, OFX/QFX parsers and number masking; statement files and receipt photos kept on the device. Fixtures for tests live in `tests/fixtures/`. |
| `src/styles/base.css` | Imports `@stackd/tokens/tokens.css`; page basics, focus ring, skip link, `.tiles` (a list in Simple layout), reduced motion. |
| `public/icons/` | Generated by `scripts/icons.ts` from the handoff mark; committed. |
| `tests/` | `setup.ts` mocks `matchMedia` (system dark, viewport width); `unit/` covers the theme provider, the shell, display settings and the manifest. |

## How theming works

`@stackd/tokens` emits CSS custom properties for `:root` (Modern light), each `[data-look][data-mode]`, and a `prefers-color-scheme: dark` fallback for looks without an explicit mode. The provider therefore sets `data-mode` only for an explicit light or dark choice and removes it for "Match system", so the OS switch is instant and happens in CSS. Simple layout is `data-simple="1"`: `.tiles` collapses to one column and anything with `sk-decor` is hidden. Components never branch on the look.

## Conventions

- Every screen starts with `<ScreenHeader title=… />`, which also sets `document.title`. Pass `actions={null}` where the global + button does not belong.
- Build screens from `@stackd/ui` (Card, List/ListRow, Toggle, ProgressBar, Chip, Button). No per-screen colour values: use `--c-*`.
- Interactive elements are at least 44 × 44 px; toggles are switches; progress bars carry `aria-valuetext`.
- Never read `Capacitor` directly; `lib/platform.ts` is the only place that does.
