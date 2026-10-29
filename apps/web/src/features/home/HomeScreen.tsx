import "./home.css";
import type { BudgetSummary } from "../../engine/bridge.ts";
import { ENTRIES_PATH } from "../entries/paths.ts";
import "../forecast/forecast.css";

import { Button, Card, Illustration, List, ProgressBar } from "@stackd/ui";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import type { NextMove } from "../../engine/bridge.ts";
import { APP_NAME } from "../../lib/brand.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { nudgeCopy } from "../../moments/catalog.ts";
import { publishWidgetSummary } from "../../native/widget.ts";
import { useSession } from "../auth/useSession.tsx";
import { TrialCard } from "../billing/TrialCard.tsx";
import { BUCKET_LABELS } from "../budget/RuleView.tsx";
import { splitLabel } from "../budget/split.ts";
import { EntryRow } from "../entries/EntryList.tsx";
import { useLookups, useRecentEntries } from "../entries/useEntries.ts";
import { shortfallLine } from "../forecast/ForecastScreen.tsx";
import { percentText } from "../groups/ChallengesTab.tsx";
import { BalanceRunway } from "../insights/InsightCard.tsx";
import { useSafeToSpend } from "../insights/useSafeToSpend.ts";
import { MonthReviewHomeCard } from "../monthreview/MonthReviewCards.tsx";
import { useSetup } from "../onboarding/useSetup.ts";
import { StorageCard } from "../pwa/StorageCard.tsx";
import { RestoreOffer } from "../security/RestoreOffer.tsx";
import { SubCheckHomeCard } from "../subscriptions/SubscriptionCheckCard.tsx";
import { CustomizeHome } from "./CustomizeHome.tsx";
import { DebtFreeCard } from "./DebtFreeCard.tsx";
import { FoundCard } from "./FoundCard.tsx";
import { BucketKey, CategoryBars, HeroBars } from "./HomeVisuals.tsx";
import { type HomeCardId, TILE_CARDS, useHomeLayout } from "./homeLayout.ts";
import { useHome } from "./useHome.ts";

/**
 * Card copy for each next move. The rule returns an id and numbers; the words live in the one
 * catalog of messages (moments.yaml `nudges`), and this only formats the numbers into it.
 */
function moveCopy(move: NextMove): { title: string; detail: string; to: string; cta: string } {
  const p = move.params;
  const days = Number(p.days);
  return nudgeCopy(move.id, {
    amount: formatCents(Number(p.amount_cents)),
    remaining: formatCents(Number(p.remaining_cents)),
    apr: `${(Number(p.apr_bps) / 100).toFixed(2)}%`,
    label: String(p.label),
    date: p.date ? formatDay(String(p.date)) : "",
    when: days === 0 ? "due today" : `in ${days} ${days === 1 ? "day" : "days"}`,
    title: String(p.title),
    behind: formatCents(Number(p.behind_cents)),
    per_period: formatCents(Number(p.per_period_cents)),
    id: String(p.id),
    runway: (Number(p.runway_tenths) / 10).toFixed(1),
  });
}

/**
 * Home (chunk 1.8): Got · Spent · Kept with the verdict and the in / out bars, Set aside this month,
 * the next move (shortfall first), then the Budget, Jars, Next 30 days and Challenge tiles and
 * recent entries. Tiles become a list in Simple layout.
 */
export function HomeScreen() {
  const navigate = useNavigate();
  const today = todayIso();
  const recent = useRecentEntries(4);
  const lookups = useLookups();
  const home = useHome(today);
  const layout = useHomeLayout();
  const [params] = useSearchParams();
  // "Arrange your Home" in Make Qash yours opens the editor straight away.
  const [customizing, setCustomizing] = useState(params.get("customize") === "1");
  const totals = home.month.totals;
  const hasMoney = Boolean(totals && totals.count > 0);
  const over = home.budget.summary?.buckets.find((b) => b.left_cents < 0) ?? null;
  const projection = home.forecast.projection;
  const safe = useSafeToSpend(home.forecast, todayIso());
  const aside = home.setAside;
  const { info } = useSession();
  const monthHasEntries = (home.month.entries ?? []).length > 0;
  const myJars = home.jars.filter((g) => g.group_id === null);
  // Set aside only means something once there's a target or a jar to put money in.
  const showSetAside = Boolean(aside && (aside.target_cents !== null || home.jars.length > 0));
  // "Make Qash yours" (October 20, 2026): the same steps as /setup, the next three shown here.
  const setupState = useSetup();
  const now = new Date();
  // The home-screen widget (chunk 2.3): the same strings as the hero; a no-op in a browser.
  useEffect(() => {
    if (!totals || totals.count === 0) return;
    void publishWidgetSummary({
      month: new Date().toLocaleDateString("en-US", { month: "long" }),
      got: formatCents(totals.in_cents),
      spent: formatCents(totals.out_cents),
      kept: formatCents(totals.net_cents),
    });
  }, [totals]);
  const hour = now.getHours();
  const firstName = (info?.user?.display_name ?? "").trim().split(" ")[0];
  const greeting = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}${firstName ? `, ${firstName}` : ""}`;
  const dateLine = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  // Each card by id; Home draws them in the person's order (owner decision, October 19, 2026).
  const cards: Record<Exclude<HomeCardId, "recent">, ReactNode> = {
    kept: (
      <Link to="/money" className="card-link" aria-label="Kept this month, open Money in & out">
        <Card tone="accent" as="section" aria-labelledby="home-kept">
          <p className="sk-card__eyebrow" id="home-kept">
            This month
          </p>
          {hasMoney && totals ? (
            <>
              <Word className="home__hero-word">{totals.net_cents < 0 ? "Over" : "Kept"}</Word>
              <p className="home__hero-number">
                {totals.net_cents < 0
                  ? `${formatCents(-totals.net_cents)} over`
                  : `${formatCents(totals.net_cents)} kept`}
              </p>
              <p className="home__verdict" role="status">
                {home.verdict === "under"
                  ? "You spent less than you earned"
                  : home.verdict
                    ? "You spent more than you earned"
                    : totals.in_cents === 0
                      ? "Nothing in yet this month"
                      : "\u00a0"}
              </p>
              <HeroBars inCents={totals.in_cents} outCents={totals.out_cents} />
              <p className="home__numbers sr-only">
                Got {formatCents(totals.in_cents)} · Spent {formatCents(totals.out_cents)} · Kept{" "}
                {formatCents(totals.net_cents)}
              </p>
            </>
          ) : monthHasEntries ? (
            <>
              <p className="home__hero-number">Only transfers so far</p>
              <p className="home__verdict">Moves between your accounts aren't spending</p>
            </>
          ) : (
            <>
              <Word className="home__hero-word">Start</Word>
              <p className="sk-card__hero sk-card__hero--empty">Nothing yet</p>
              <p>Add your first entry or statement and this fills in.</p>
            </>
          )}
        </Card>
      </Link>
    ),
    found: <FoundCard asOf={today} />,
    sub_check: <SubCheckHomeCard today={today} />,
    month_review: <MonthReviewHomeCard today={today} />,
    where:
      hasMoney && totals?.by_category.some((c) => c.out_cents > 0) ? (
        <Link to="/money" className="card-link" aria-label="Where it went, open Money in & out">
          <Card as="section" aria-labelledby="home-where">
            <h2 className="sk-card__title" id="home-where">
              Where it went
            </h2>
            <Word>Spent</Word>
            <CategoryBars byCategory={totals.by_category} categories={lookups?.categories} />
            <BucketKey />
          </Card>
        </Link>
      ) : null,
    aside: showSetAside ? (
      <Link to="/goals" className="card-link" aria-label="Set aside this month, open Goals">
        <Card as="section" aria-labelledby="home-aside">
          <h2 className="sk-card__title" id="home-aside">
            Set aside{" "}
            {aside
              ? aside.target_cents !== null
                ? `${formatCents(aside.set_aside_cents)} of ${formatCents(aside.target_cents)}`
                : formatCents(aside.set_aside_cents)
              : ""}{" "}
            this month
          </h2>
          <Word>Saved</Word>
          {aside?.target_cents !== null && aside?.target_cents !== undefined ? (
            <ProgressBar
              fraction={Math.min(1, (aside.progress_bps ?? 0) / 10000)}
              label="Set aside toward this month's save target"
              valueText={`${Math.round((aside.progress_bps ?? 0) / 100)}% of ${formatCents(aside.target_cents)}`}
            />
          ) : null}
          <p className="sk-card__eyebrow">
            {!aside
              ? "Working it out…"
              : aside.target_cents === null
                ? "Set your pay in Budget to get a monthly target."
                : aside.paydays_so_far > 0
                  ? `${aside.paydays_set_aside} of ${aside.paydays_so_far} ${aside.paydays_so_far === 1 ? "payday" : "paydays"} set aside so far`
                  : "Jar deposits you log count here."}
          </p>
        </Card>
      </Link>
    ) : null,
    move: projection?.shortfall ? (
      <Link
        to="/forecast"
        className="card-link"
        aria-label="Shortfall warning, open the next 30 days"
      >
        <Card as="section" className="forecast__warn" aria-labelledby="home-move">
          <Word>Short</Word>
          <h2 className="sk-card__title" id="home-move">
            {shortfallLine(projection)}
          </h2>
          <p>An estimate from your own history. See what's coming and what would cover it.</p>
        </Card>
      </Link>
    ) : home.move ? (
      <Card as="section" aria-labelledby="home-move" className="home__move">
        <Word>Next</Word>
        <h2 className="home__move-title" id="home-move">
          {moveCopy(home.move).title}
        </h2>
        <p>{moveCopy(home.move).detail}</p>
        <Button
          block
          onClick={async () => {
            const copy = moveCopy(home.move as NextMove);
            if (home.move?.id === "payday_set_aside") {
              const logged = await home.logSetAside();
              if (!logged) navigate("/goals/new");
              return;
            }
            navigate(copy.to);
          }}
        >
          {moveCopy(home.move).cta}
        </Button>
      </Card>
    ) : null,
    next30: (
      <Link to="/forecast" className="card-link" aria-label="Open the next 30 days">
        <Card as="section" aria-labelledby="home-forecast">
          <h2 className="sk-card__title" id="home-forecast">
            Next 30 days
          </h2>
          <Word>
            {home.forecast.needsBalance
              ? "Start"
              : projection?.shortfall
                ? "Short"
                : projection
                  ? "Covered"
                  : "Soon"}
          </Word>
          {safe && !projection?.shortfall ? (
            <>
              <p className="home__big">
                {formatCents(safe.per_day_cents)}
                <span className="home__big-unit"> a day to spend</span>
              </p>
              <p className="sk-card__eyebrow">
                {safe.window === "pay_period" && safe.payday
                  ? `Through next pay period, to ${formatDay(safe.payday)}, after bills`
                  : safe.window === "payday" && safe.payday
                    ? `Until payday, ${formatDay(safe.payday)}, after bills`
                    : "After the bills coming up"}
              </p>
            </>
          ) : null}
          {projection && !home.forecast.needsBalance ? (
            <BalanceRunway
              days={projection.days.filter((d) => d.date >= today)}
              cushionCents={home.forecast.bufferCents}
              endLabel={formatDay(projection.days[projection.days.length - 1]?.date ?? today)}
            />
          ) : null}
          <p className="sk-card__eyebrow">
            {home.forecast.loading
              ? "Working it out…"
              : home.forecast.needsBalance
                ? "Add your account balance to see 30 days ahead"
                : projection?.shortfall
                  ? shortfallLine(projection)
                  : projection
                    ? `Lowest ${formatCents(projection.lowest_cents)} around ${formatDay(projection.lowest_date)} · no shortfall expected`
                    : ""}
            {home.forecast.upcoming && home.forecast.upcoming.items.length > 0
              ? ` · ${home.forecast.upcoming.items.length} upcoming`
              : ""}
          </p>
        </Card>
      </Link>
    ),
    setup:
      setupState && !setupState.dismissed && setupState.left > 0 ? (
        <Card as="section" aria-labelledby="home-setup" className="setup">
          <h2 className="sk-card__title" id="home-setup">
            Make {APP_NAME} yours · {setupState.steps.length - setupState.left} of{" "}
            {setupState.steps.length}
          </h2>
          <Word>Start</Word>
          <span className="setup__dots" aria-hidden="true">
            {setupState.steps.map((st) => (
              <span key={st.id} className={`setup__dot${st.done ? " setup__dot--done" : ""}`} />
            ))}
          </span>
          <List aria-label="Still to set up">
            {setupState.steps
              .filter((st) => !st.done)
              .slice(0, 3)
              .map((item) => (
                <li className="sk-list__item" key={item.id}>
                  <Link className="sk-row sk-row--interactive setup__row" to={item.to}>
                    <span className="sk-row__text">
                      <span className="sk-row__label">{item.title}</span>
                      <span className="sk-row__sublabel">{item.line}</span>
                    </span>
                  </Link>
                </li>
              ))}
          </List>
          <Link to="/setup" className="setup__all">
            See all, or say you're done
          </Link>
        </Card>
      ) : null,
    debt_free: <DebtFreeCard today={today} />,
    budget: home.budget.budget ? (
      <Link to="/budget" className="card-link" aria-label="Open Budget">
        <Card as="section" aria-labelledby="home-budget">
          <h2 className="sk-card__title" id="home-budget">
            Budget
            {home.budget.budget
              ? ` · ${home.budget.budget.method === "50_30_20" ? splitLabel(home.budget.budget.split_bps) : "Zero-based"}`
              : ""}
          </h2>
          <Word>{over ? "Over" : "Steady"}</Word>
          <p className="sk-card__eyebrow">
            {!home.budget.budget
              ? "Not set up yet"
              : home.budget.budget.method === "zero_based"
                ? zeroBasedLine(home.budget.summary)
                : over
                  ? `${BUCKET_LABELS[over.bucket][0]} ${formatCents(-over.left_cents)} over`
                  : "On track"}
          </p>
        </Card>
      </Link>
    ) : null,
    jars:
      myJars.length > 0 ? (
        <Link to="/goals" className="card-link" aria-label="Open Goals">
          <Card as="section" aria-labelledby="home-jars">
            <h2 className="sk-card__title" id="home-jars">
              Jars{home.jars.length ? ` · ${home.jars.length}` : ""}
            </h2>
            <Word>Saving</Word>
            <p className="sk-card__eyebrow">
              {home.jars.length
                ? home.jars
                    .filter((g) => g.group_id === null)
                    .map((g) => g.title)
                    .slice(0, 3)
                    .join(", ") || "Challenge jars only"
                : "No jars yet"}
            </p>
          </Card>
        </Link>
      ) : null,
    challenge: home.challenge ? (
      <Link
        to={home.challenge ? `/groups/${home.challenge.id}` : "/goals"}
        className="card-link"
        aria-label={home.challenge ? `Open challenge ${home.challenge.name}` : "Open challenges"}
      >
        <Card as="section" aria-labelledby="home-challenge">
          <h2 className="sk-card__title" id="home-challenge">
            Challenge
          </h2>
          <Word>
            {home.challenge && home.challenge.my_progress_bps >= 10000 ? "Reached" : "Saving"}
          </Word>
          <p className="sk-card__eyebrow">
            {home.challenge
              ? `${home.challenge.name} · ${percentText(home.challenge.my_progress_bps)}`
              : "None yet. Start one or join with a code."}
          </p>
        </Card>
      </Link>
    ) : null,
  };
  const hidden = new Set(layout.hidden);
  const shown = layout.order.filter(
    (id): id is Exclude<HomeCardId, "recent"> => id !== "recent" && !hidden.has(id),
  );
  // A low-balance warning is never hidden: with Next move off it still leads.
  if (projection?.shortfall && hidden.has("move")) shown.unshift("move");
  const homeCards: ReactNode[] = [];
  let tiles: ReactNode[] = [];
  let tilesKey = "";
  const flush = () => {
    // Keyed by the first tile in the group, so a card appearing above never remounts the tiles.
    if (tiles.length)
      homeCards.push(
        <div className="tiles" key={`tiles-${tilesKey}`}>
          {tiles}
        </div>,
      );
    tiles = [];
  };
  for (const id of layout.ready ? shown : []) {
    const card = cards[id];
    if (!card) continue;
    const keyed = <Fragment key={id}>{card}</Fragment>;
    if (TILE_CARDS.has(id)) {
      if (!tiles.length) tilesKey = id;
      tiles.push(keyed);
    } else {
      flush();
      homeCards.push(keyed);
    }
  }
  flush();

  return (
    <>
      <ScreenHeader eyebrow={dateLine} title={greeting} />
      <div className="two-pane">
        <div className="pane pane--main">
          <TrialCard />
          <RestoreOffer />
          <StorageCard />
          {homeCards}
          <Button
            variant="ghost"
            size="sm"
            className="home__customize"
            onClick={() => setCustomizing(true)}
          >
            Customize Home
          </Button>
        </div>
        <div className="pane pane--side">
          {!layout.ready || hidden.has("recent") ? null : (
            <section aria-labelledby="home-recent">
              <div className="entries-month">
                <h2 className="section-title" id="home-recent">
                  Recent entries
                </h2>
                <Link to={ENTRIES_PATH}>See all</Link>
              </div>
              {recent && recent.length > 0 ? (
                <List card>
                  {recent.map((e) => (
                    <EntryRow
                      key={e.id}
                      entry={e}
                      lookups={lookups}
                      onOpen={() => navigate(`/entries/${e.id}`)}
                    />
                  ))}
                </List>
              ) : (
                <Card>
                  <Illustration name="sprout" tone="a2" />
                  <p>Nothing yet. Tap + to add what you spent or earned.</p>
                </Card>
              )}
            </section>
          )}
        </div>
      </div>
      <CustomizeHome open={customizing} onClose={() => setCustomizing(false)} layout={layout} />
    </>
  );
}

/** Home's Budget tile for zero-based (October 23, 2026): what still needs a job, else what's over. */
function zeroBasedLine(summary: BudgetSummary | null): string {
  if (!summary) return "Zero-based";
  const left = summary.left_to_assign_cents ?? 0;
  if (left > 0) return `${formatCents(left)} left to assign`;
  if (left < 0) return `${formatCents(-left)} over-assigned`;
  const over = summary.categories.filter(
    (c) => c.planned_cents !== null && c.spent_cents > c.planned_cents,
  ).length;
  return over
    ? `${over} ${over === 1 ? "category" : "categories"} over plan`
    : "Every dollar has a job";
}
