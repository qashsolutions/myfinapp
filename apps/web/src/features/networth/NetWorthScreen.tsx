import "./networth.css";
import "../auth/auth.css";
import "../insights/insights.css";

import { Button, Card, Chip, List, ListRow, Sheet, Toggle } from "@stackd/ui";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type NetWorthPoint, parseAmount } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import { RangePicker, RangeStepper } from "../ranges/RangePicker.tsx";
import { type Range, useRange } from "../ranges/ranges.ts";
import {
  ASSET_GROUPS,
  chooseFor,
  DEBT_GROUPS,
  GROUP_LABEL,
  removeManual,
  STALE_DAYS,
  saveManual,
  useNetWorth,
  useNetWorthRange,
  type WorthRow,
} from "./useNetWorth.ts";

/** Own vs owe as two bars, the longer one full width: green what you own, red what you owe. */
export function WorthBars({ assets, debts }: { assets: number; debts: number }) {
  const max = Math.max(assets, debts, 1);
  return (
    <div className="worth-bars" aria-hidden="true">
      {(
        [
          ["Own", assets, "own"],
          ["Owe", debts, "owe"],
        ] as const
      ).map(([label, cents, kind]) => (
        <div className="worth-bars__row" key={kind}>
          <span>{label}</span>
          <span className="worth-bars__track">
            <span
              className={`worth-bars__fill worth-bars__fill--${kind}`}
              style={{ width: `${cents === 0 ? 0 : Math.max(2, (cents / max) * 100)}%` }}
            />
          </span>
          <span className="worth-bars__value">{formatCents(cents)}</span>
        </div>
      ))}
    </div>
  );
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Net worth over the range, drawn at the card's real width like Next 30 days: a dot and a date
 * under each point (the start, each month end, today), the start and today's totals labelled,
 * and, when it crosses zero, a labelled $0 line with what's above it green and below it red.
 */
function WorthChart({ points }: { points: NetWorthPoint[] }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      if (width > 0) setW(Math.max(240, width));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const known = points.filter(
    (p): p is NetWorthPoint & { net_cents: number } => p.net_cents !== null,
  );
  // The box is always there so its width is measured before the points arrive.
  if (known.length < 2) return <div ref={box} className="runway-box" />;
  const H = 150;
  const top = 28;
  const bottom = 112;
  const left = 10;
  const right = W - 10;
  const values = known.map((p) => p.net_cents);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const crosses = lo < 0 && hi > 0;
  const span = hi - lo || 1;
  const x = (i: number) => left + (i / (known.length - 1)) * (right - left);
  const y = (v: number) => bottom - ((v - lo) / span) * (bottom - top);
  const line = known.map((p, i) => `${x(i).toFixed(1)},${y(p.net_cents).toFixed(1)}`).join(" ");
  const base = crosses ? y(0) : bottom;
  const area = `${left},${base} ${line} ${right},${base}`;
  const first = known[0] as NetWorthPoint & { net_cents: number };
  const last = known[known.length - 1] as NetWorthPoint & { net_cents: number };
  const every = Math.max(1, Math.ceil(known.length / 6));
  const dateLabel = (p: NetWorthPoint, i: number) =>
    i === known.length - 1
      ? "Today"
      : i === 0
        ? `${SHORT[Number(p.date.slice(5, 7)) - 1]} ${Number(p.date.slice(8, 10))}`
        : (SHORT[Number(p.date.slice(5, 7)) - 1] ?? p.date);
  const valueY = (v: number) => (y(v) - 10 > 14 ? y(v) - 10 : y(v) + 20);
  return (
    <div ref={box} className="runway-box">
      <svg
        className="runway"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Net worth: ${formatCents(first.net_cents)} on ${formatDay(first.date)}, ${formatCents(last.net_cents)} today${crosses ? "; it crossed zero" : ""}`}
      >
        <defs>
          <clipPath id={`${id}-up`}>
            <rect x="0" y="0" width={W} height={base} />
          </clipPath>
          <clipPath id={`${id}-down`}>
            <rect x="0" y={base} width={W} height={H - base} />
          </clipPath>
        </defs>
        {crosses ? (
          <>
            <polygon className="runway__room" points={area} clipPath={`url(#${id}-up)`} />
            <polygon className="runway__short" points={area} clipPath={`url(#${id}-down)`} />
            <line className="runway__cushion" x1={left} x2={right} y1={base} y2={base} />
            <text className="runway__note" x={left} y={base - 5}>
              $0
            </text>
          </>
        ) : (
          <polygon className={lo >= 0 ? "runway__room" : "runway__short"} points={area} />
        )}
        <polyline className="runway__line" points={line} />
        {known.map((p, i) => (
          <circle
            key={p.date}
            className={p.net_cents < 0 ? "runway__dot runway__dot--short" : "runway__dot"}
            cx={x(i)}
            cy={y(p.net_cents)}
            r={i === known.length - 1 ? 4.5 : 3}
          />
        ))}
        <text
          className={first.net_cents < 0 ? "runway__label runway__label--short" : "runway__label"}
          x={left}
          y={valueY(first.net_cents)}
        >
          {formatCents(first.net_cents)}
        </text>
        <text
          className={last.net_cents < 0 ? "runway__label runway__label--short" : "runway__label"}
          x={right}
          y={valueY(last.net_cents)}
          textAnchor="end"
        >
          {formatCents(last.net_cents)}
        </text>
        {known.map((p, i) =>
          i % every === 0 || i === known.length - 1 ? (
            <text
              key={p.date}
              className="runway__axis"
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === known.length - 1 ? "end" : "middle"}
            >
              {dateLabel(p, i)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

const OVER: Record<Range, string> = {
  Month: "this month",
  Quarter: "in 3 months",
  Year: "in 12 months",
  YTD: "this year",
};

interface Editing {
  id?: string;
  kind: "asset" | "debt";
  group: string;
  label: string;
  amount: string;
}

/**
 * Net worth (owner decision, October 19, 2026): what you own minus what you owe, from the items
 * the person chooses. Qash accounts and Debt payoff debts each have an Include switch; anything
 * else is added by hand and dated. Own values and latest balances only; never advice.
 */
export function NetWorthScreen() {
  const { db } = useDb();
  const ids = useId();
  const today = todayIso();
  const view = useNetWorth(today);
  const { range, setRange, back, setBack } = useRange("networth", "Year");
  const ranged = useNetWorthRange(view.rows, range, today, back);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = view.summary;

  async function save() {
    if (!editing) return;
    const label = editing.label.trim();
    if (!label) return setError("Give it a name, like “401(k)” or “Car”.");
    let cents: number;
    try {
      cents = await parseAmount(editing.amount);
    } catch {
      return setError("Enter an amount like 12,500.");
    }
    if (cents < 0) return setError("Enter the amount without a minus sign.");
    await saveManual(db, {
      id: editing.id,
      kind: editing.kind,
      group: editing.group,
      label: label.slice(0, 30),
      value_cents: cents,
    });
    setEditing(null);
  }

  function row(r: WorthRow) {
    const value = r.valueCents === null ? "No balance yet" : formatCents(r.valueCents);
    const where =
      r.source === "account"
        ? "Account"
        : r.source === "debt"
          ? "From Debt payoff"
          : r.updatedAt
            ? `Updated ${formatDay(r.updatedAt.slice(0, 10))}`
            : "";
    if (r.source === "manual")
      return (
        <ListRow
          key={r.key}
          label={r.label}
          sublabel={`${GROUP_LABEL[r.group] ?? r.group} · ${where}`}
          value={value}
          onClick={() =>
            setEditing({
              id: r.itemId ?? undefined,
              kind: r.kind,
              group: r.group,
              label: r.label,
              amount: ((r.valueCents ?? 0) / 100).toFixed(2),
            })
          }
          chevron
        />
      );
    return (
      <li key={r.key} className="worth-row">
        <div className="worth-row__text">
          <span className="worth-row__label">{r.label}</span>
          <span className="worth-row__sub">
            {GROUP_LABEL[r.group] ?? r.group} · {where}
            {r.valueCents === null ? (
              <>
                {" · "}
                <Link to="/me/accounts">Set a balance</Link>
              </>
            ) : null}
          </span>
        </div>
        <span
          className={r.included ? "worth-row__value" : "worth-row__value worth-row__value--off"}
        >
          {value}
        </span>
        <Toggle
          className="worth-row__switch"
          checked={r.included}
          label={`Count ${r.label}`}
          onChange={(on) => void chooseFor(db, r, { included: on })}
        />
      </li>
    );
  }

  const own = view.rows.filter((r) => r.kind === "asset");
  const owe = view.rows.filter((r) => r.kind === "debt");
  const change = ranged.change;

  return (
    <>
      <ScreenHeader title="Net worth" back="/insights" actions={null} />
      <div className="worth">
        <Card as="section" aria-labelledby={`${ids}-total`} className="worth__hero">
          <p className="sk-card__eyebrow">What you own minus what you owe</p>
          <p className="worth__total" id={`${ids}-total`}>
            {s ? formatCents(s.net_cents) : "…"}
          </p>
          {change !== null ? (
            <Chip tone={change > 0 ? "success" : change < 0 ? "danger" : "neutral"}>
              {change > 0 ? "▲ " : change < 0 ? "▼ " : ""}
              {formatCents(Math.abs(change))}
              {ranged.changeBps !== null
                ? ` (${change < 0 ? "−" : "+"}${Math.abs(Math.round(ranged.changeBps / 100))}%)`
                : ""}{" "}
              {back === 0 || !ranged.bounds ? OVER[range] : `in ${ranged.bounds.label}`}
            </Chip>
          ) : null}
          {s ? <WorthBars assets={s.assets_cents} debts={s.debts_cents} /> : null}
          <RangePicker value={range} onChange={setRange} label="Net worth over" />
          <RangeStepper bounds={ranged.bounds} onBack={setBack} />
          <WorthChart points={ranged.points} />
          {ranged.partial ? (
            <p className="worth__stale" role="note">
              Some accounts start later: their history begins with their first entry.
            </p>
          ) : null}
          {ranged.addedLater ? (
            <p className="worth__stale" role="note">
              Debts and things you added by hand count from the day you added them.
            </p>
          ) : null}
          {view.stale > 0 ? (
            <p className="worth__stale" role="note">
              {view.stale === 1 ? "1 value" : `${view.stale} values`} not updated in {STALE_DAYS}{" "}
              days. Tap one to update it.
            </p>
          ) : null}
        </Card>

        <section aria-labelledby={`${ids}-own`}>
          <h2 className="worth__h" id={`${ids}-own`}>
            What you own{s ? <span> {formatCents(s.assets_cents)}</span> : null}
          </h2>
          {own.length ? <List card>{own.map(row)}</List> : null}
          <Button
            variant="secondary"
            block
            onClick={() =>
              setEditing({ kind: "asset", group: "investments", label: "", amount: "" })
            }
          >
            + Something you own
          </Button>
        </section>

        <section aria-labelledby={`${ids}-owe`}>
          <h2 className="worth__h" id={`${ids}-owe`}>
            What you owe{s ? <span> {formatCents(s.debts_cents)}</span> : null}
          </h2>
          {owe.length ? <List card>{owe.map(row)}</List> : null}
          <Button
            variant="secondary"
            block
            onClick={() => setEditing({ kind: "debt", group: "mortgage", label: "", amount: "" })}
          >
            + Something you owe
          </Button>
        </section>

        <p className="worth__note">
          Your own values and latest balances, kept on this device. An estimate, not advice.
        </p>
      </div>

      <Sheet
        open={editing !== null}
        onClose={() => {
          setEditing(null);
          setError(null);
        }}
        title={
          editing?.id
            ? "Update"
            : editing?.kind === "debt"
              ? "Something you owe"
              : "Something you own"
        }
      >
        {editing ? (
          <>
            <label className="auth__field">
              <span className="auth__label">Name</span>
              <input
                className="auth__input"
                maxLength={30}
                placeholder={editing.kind === "debt" ? "Mortgage" : "401(k)"}
                value={editing.label}
                onChange={(e) => setEditing({ ...editing, label: e.target.value })}
              />
            </label>
            <fieldset className="chips" style={{ border: 0, margin: 0, padding: "4px 0" }}>
              <legend className="auth__label">What is it?</legend>
              <ChoiceChips
                name={`${ids}-group`}
                options={(editing.kind === "debt" ? DEBT_GROUPS : ASSET_GROUPS).map(([k, l]) => [
                  k,
                  l,
                ])}
                value={editing.group}
                onPick={(v) => setEditing({ ...editing, group: v })}
              />
            </fieldset>
            <label className="auth__field">
              <span className="auth__label">
                {editing.kind === "debt" ? "Amount owed" : "What it's worth"}
              </span>
              <input
                className="auth__input"
                inputMode="decimal"
                placeholder="0.00"
                value={editing.amount}
                onChange={(e) => setEditing({ ...editing, amount: e.target.value })}
              />
            </label>
            {error ? (
              <p className="auth__error" role="alert">
                {error}
              </p>
            ) : null}
            <Button block onClick={() => void save()}>
              Save
            </Button>
            {editing.id ? (
              <Button
                variant="secondary"
                block
                onClick={() => {
                  if (editing.id) void removeManual(db, editing.id);
                  setEditing(null);
                }}
              >
                Remove
              </Button>
            ) : null}
          </>
        ) : null}
      </Sheet>
    </>
  );
}
