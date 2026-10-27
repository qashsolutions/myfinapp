# stackd_rules

All of Stackd's money math. Pure functions: inputs plus an explicit `as_of` go in, a result comes out. No I/O, no clock, no randomness, no third-party dependencies. This package runs on the user's device (Pyodide or a TypeScript port, decided in chunk 0.6) and on the server; both must pass the same golden tests.

## Conventions

- Money is integer cents. Percentages are basis points (`bps`, 10000 = 100%). Rounding is half-even and happens inside `money.round_div`; nothing else rounds.
- Dates are ISO `YYYY-MM-DD` strings at the boundary and `datetime.date` inside. There are no times or time zones: the caller passes the user's local calendar date as `as_of`.
- `RULES_VERSION` (in `stackd_rules/__init__.py`) is stamped on every computed result. Bump it whenever any rule's output can change for the same input. It must equal the version in `pyproject.toml`.
- Validation failures raise `RuleError(code)` with a stable snake_case code. Rules never raise anything else for bad input.
- `registry.RULES` maps `"<module>.<rule>"` to a function that takes the input JSON object as keyword arguments and returns a JSON object. That is the contract the on-device engine implements, and the shape every golden test uses.

## Modules

| Module | Rules | Notes |
|---|---|---|
| `money.py` | `parse_amount`, `round_div`, `pct_of`, `allocate`, `ratio_bps` | Integer cents, half-even rounding in one place. |
| `dates.py` | `month_bounds`, `add_months`, `days_until`, `week_bounds`, `next_paydays`, `periods_until` | Calendar maths for an explicit `as_of`. |
| `fingerprint.py` | `clean_description`, `row` | Dedupe keys for imported statement rows: FNV-1a 64 over account, date, cents and the cleaned description. Cleaning upper-cases ASCII letters only, because the TypeScript port must produce identical bytes. |
| `categorize.py` | `match` | User rules first, then the keyword table; case-insensitive substring on the cleaned description, first match wins; flags likely transfers. The table is an input, so the rule stays pure. |
| `cashflow.py` | `month_totals`, `period_totals`, `net_change`, `match_transfers` | Month (or any two dates inclusive: the weekly recap) In and Out (transfers excluded, refunds net against their category unless given an income category), Net = In − Out, by category and by account; the change versus last month; transfer suggestions (equal opposite amounts, different accounts, within 5 days, closest first, each entry once). Entries are passed in with their category kind. |
| `budget.py` | `targets_50_30_20`, `monthly_take_home`, `summary` | 50/30/20 targets (rounding remainder to save), a paycheck and frequency to a monthly figure, and planned vs spent per bucket and category for either method (transfers and future-dated entries excluded, refunds net against their category, zero-based left to assign, kept floored at 0). Entries and lines carry their category's bucket. |
| `goals.py` | `progress`, `spend_less_baseline` | One progress rule for the four kinds: save = deposits ÷ target; payoff = (start − latest balance) ÷ start, latest by date then input order; spend-less = (baseline − period spend) ÷ amount to save (negative when over); habit = check-ins ÷ days, one per calendar day. `display_bps` is capped at 100%, `progress_bps` is the true value; `weekly_pace` = remaining ÷ ceil(days left ÷ 7); `status` is active, reached or overdue. The baseline is the user's estimate in month 1, then the mean of the last three months. |
| `goals_custom.py` | `jar`, `plan`, `streak`, `milestones` | A jar with the user's own name, amount and date: name trimmed of ASCII whitespace, 1–10 characters (owner decision); amount > 0; deadline today or later, or none. Returns the normalised goal and its `days_left`, `weeks_left`, `weekly_pace` from `goals.progress` with no events. Cadence, per-period amounts, finish dates, ongoing goals and milestones are fast-follow 3. |
| `groups.py` | `rank` | Leaderboard order: percent of own target descending, ties by earliest reach time (ISO UTC strings compared as text), then input order. Members with no events yet are returned in `hidden`, not ranked. Percentages keep their true value; capping at 100% is display. |
| `household.py` | `split_contributions`, `combine_totals` | A shared jar's contribution per member (own deposits only; unknown members are an error) and the household's combined In / Out / Net from members' month totals. |
| `recurring.py` | `detect` | Same cleaned payee and direction, the most recent run of 3+ occurrences whose gaps all fit one interval (weekly 4–10 days, every 2 weeks 11–17, monthly 25–34), every amount within ±10% of the run's median. Suggests `expected_cents` (the median), the interval and the next date. Transfers and future entries are ignored; the user confirms. |
| `forecast.py` | `typical_daily_spending`, `start_balance`, `upcoming`, `project` | Non-recurring Out over the last 90 days ÷ 90 (or budgeted needs + wants ÷ days in month under 30 days of history); anchor balance + entries after it; every series expanded over the window and matched to real entries within ±3 days and ±10%; the day-by-day balance (start − daily × d + unmatched income − unmatched bills) with the lowest point, the first day under the buffer and the shortfall amount. The `mockup_shortfall` golden reproduces the F3Forecast mockup. |
| `emergency.py` | `summary` | Runway = saved ÷ monthly essentials in tenths of a month (hidden when essentials are 0); milestones for the $1,000 starter fund, one month of essentials and the 3- or 6-month target, each with progress and `eta_months` = ceil((target − saved) ÷ monthly plan), null without a plan. |
| `bills.py` | `avalanche_order`, `payoff_plan` | Cards and loans by APR descending, then balance ascending, then label; totals and the highest APR. The payoff plan runs the avalanche month by month on a fixed budget (every minimum plus an extra): interest half-even on each balance, minimums first, the rest to the highest rate, spilling down; debt-free month, total interest, each debt's payoff month, the balance after each month; `stalled` past 600 months. Nothing is moved. |
| `growth.py` | `compound` | FV = P × ((1 + r)^n − 1) ÷ r, r = annual rate ÷ 12, computed as an exact fraction and rounded half-even once (years 1–50, rate up to 500%); r = 0 → P × n. An illustration, never a prediction. |
| `notify.py` | `decide` | One candidate alert in the user's local time: duplicate or disabled → skip; not due → wait; paused → skip; quiet hours (may span midnight) → defer to their end; daily max reached → tomorrow's summary; else send. |
| `alerts.py` | `schedule` | The device's next 30 days of alerts as dates, types and dedupe keys: bills `lead_days` before at 09:00, shortfall once per change, daily challenge check-ins, goals behind pace (expected-by-now − saved ≥ periods × weekly pace), reported milestones, the next weekly recap. |
| `next_move.py` | `pick`, `set_aside`, `payday_nudge` | Home's card: the first rule in `config/next_move.yaml`'s order whose condition holds (shortfall first, start a goal last), thresholds from the config. Set aside: this month's jar deposits against the save target and which paydays had a deposit in their pay period. Payday nudge: target × paycheck ÷ monthly take-home, half-even, else a configured share of the paycheck. |

`config/next_move.yaml` is Home's next-move order and thresholds (human-edited); `uv run python scripts/build_next_move.py` writes `next_move.json` here and in `packages/rules/src/`; `tests/test_next_move_config.py` fails when a copy is stale or the order does not start with `shortfall`. `config/keywords.yaml` is the default merchant keyword table (human-edited). `uv run python scripts/build_keywords.py` writes `config/keywords.json` here and `packages/rules/src/keywords.json` for the port; `tests/test_keywords.py` fails when either copy is stale. Both JSON files are generated and ignored by Biome.

## Golden tests

`tests/golden/<rule>/<case>.input.json` and `<case>.expected.json`. The harness calls `RULES[rule](**input)` and compares the JSON-round-tripped result to `expected` exactly. A `RuleError` becomes `{"error": "<code>"}`. Expected files are written by hand from the spec, never generated from the code under test. Every registered rule needs at least one case, and every case directory must name a registered rule.

```bash
uv sync                      # once; installs Python 3.12 + dev tools
uv run pytest                # all golden tests
uv run pytest -k "money.allocate"   # one rule
uv run pytest -k "money.allocate and remainder"   # one case
uv run ruff check .
```
