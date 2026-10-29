import helpedCatalog from "@stackd/rules/helped";
import { Button, Card } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { api, failureOf, type GroupDetail } from "../../data/api.ts";
import { useBoxWidth } from "../../lib/useBoxWidth.ts";

interface Catalog {
  max_choices: number;
  min_answers: number;
  choices: Array<{ id: string; label: string }>;
}
/** The one fixed list (stackd_rules/config/helped.yaml), shared with the server. */
export const HELPED = helpedCatalog as Catalog;
const LABELS = new Map(HELPED.choices.map((c) => [c.id, c.label] as const));

/** Saves my answer: only the choice ids leave the device, never anything typed. */
export async function saveHelped(groupId: string, choices: string[]): Promise<GroupDetail | null> {
  const r = await api.PUT("/api/groups/{group_id}/helped", {
    params: { path: { group_id: groupId } },
    body: { choices },
  });
  return failureOf(r) ? null : (r.data ?? null);
}

const ROW = 40;
const BAR = 10;
const VALUE = 56; // room at the bar's end for "12 of 12"

/** "2 of 2 said Packed lunch (your pick), 1 of 2 said Cooked at home" for screen readers. */
export function helpedText(rows: Array<[string, number]>, of: number, mine: string[]): string {
  return rows
    .map(
      ([id, n]) =>
        `${n} of ${of} said ${LABELS.get(id) ?? id}${mine.includes(id) ? " (your pick)" : ""}`,
    )
    .join(", ");
}

/**
 * The group's totals as a ranked bar chart (October 29, 2026): most said first, one bar per
 * choice someone picked, my own picks marked with a tick and the accent colour. Counts come
 * straight from the server; the widths are only their picture.
 */
export function HelpedChart({
  rows,
  of,
  mine,
}: {
  rows: Array<[string, number]>;
  of: number;
  mine: string[];
}) {
  const [box, width] = useBoxWidth(320, 200);
  const track = Math.max(40, width - VALUE);
  return (
    <div ref={box} className="helped-chart">
      <svg
        width={width}
        height={rows.length * ROW}
        viewBox={`0 0 ${width} ${rows.length * ROW}`}
        role="img"
        aria-label={`What helped the group: ${helpedText(rows, of, mine)}`}
      >
        {rows.map(([id, n], i) => {
          const y = i * ROW;
          const own = mine.includes(id);
          const w = of > 0 ? Math.max(4, Math.round((n / of) * track)) : 0;
          return (
            <g key={id}>
              <text x={0} y={y + 14} className="helped-chart__label">
                {own ? "✓ " : ""}
                {LABELS.get(id) ?? id}
              </text>
              <rect x={0} y={y + 20} width={track} height={BAR} rx={BAR / 2} fill="var(--c-line)" />
              <rect
                x={0}
                y={y + 20}
                width={w}
                height={BAR}
                rx={BAR / 2}
                fill={own ? "var(--c-a1)" : "var(--c-sub)"}
              />
              <text
                x={width}
                y={y + 29}
                textAnchor="end"
                className="helped-chart__value"
              >{`${n} of ${of}`}</text>
            </g>
          );
        })}
      </svg>
      {mine.some((id) => rows.some(([r]) => r === id)) ? (
        <p className="helped-chart__key">
          <span className="helped-chart__swatch" aria-hidden /> ✓ Your picks
        </p>
      ) : null}
    </div>
  );
}

/**
 * "What helped?" (docs/spec.md "Groups"; instead of a forum): once I reached my target or the
 * challenge ended, up to five choices from one fixed list, then the group's totals as a ranked
 * bar chart ("6 of 9 said Packed lunch"), shown only once two other members answered, so no
 * answer is anyone's.
 */
export function WhatHelped({
  group,
  onSaved,
}: {
  group: GroupDetail;
  /** The group as the save answered it, totals and my picks included. */
  onSaved: (detail: GroupDetail) => void;
}) {
  const ids = useId();
  const [picked, setPicked] = useState<string[]>(group.my_helped);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  useEffect(() => setPicked(group.my_helped), [group.my_helped]);

  const full = picked.length >= HELPED.max_choices;
  const changed = picked.join(",") !== group.my_helped.join(",");
  const totals = group.helped
    ? Object.entries(group.helped.counts)
        .filter(([id, n]) => LABELS.has(id) && n > 0)
        .sort(
          (a, b) =>
            b[1] - a[1] ||
            HELPED.choices.findIndex((c) => c.id === a[0]) -
              HELPED.choices.findIndex((c) => c.id === b[0]),
        )
    : [];

  return (
    <Card as="section" aria-label="What helped">
      <Word>{group.my_helped.length ? "Shared" : "Helped"}</Word>
      <h2 className="sk-card__title">What helped?</h2>
      <p>
        {group.helped
          ? `${group.helped.answered} answered. Pick up to ${HELPED.max_choices} of your own.`
          : `Pick up to ${HELPED.max_choices}. The group sees totals only, never who chose what.`}
      </p>
      {group.helped && totals.length ? (
        <HelpedChart rows={totals} of={group.helped.answered} mine={group.my_helped} />
      ) : null}
      <fieldset className="chips" style={{ border: 0, margin: 0, padding: "4px 0 12px" }}>
        <legend className="sr-only">What helped you</legend>
        {HELPED.choices.map((c) => {
          const on = picked.includes(c.id);
          return (
            <label className="chip-option" key={c.id}>
              <input
                className="segmented__input"
                type="checkbox"
                name={`${ids}-helped`}
                checked={on}
                disabled={!on && full}
                onChange={() => {
                  setStatus("idle");
                  setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]));
                }}
              />
              {c.label}
            </label>
          );
        })}
      </fieldset>
      <Button
        size="sm"
        disabled={!changed || status === "saving"}
        onClick={async () => {
          setStatus("saving");
          const saved = await saveHelped(group.id, picked);
          if (!saved) return setStatus("failed");
          setStatus("saved");
          onSaved(saved);
        }}
      >
        Save
      </Button>
      <p className="auth__hint" role="status">
        {status === "saved"
          ? "Saved. Thanks for sharing."
          : status === "failed"
            ? "Couldn't save. Try again when you're online."
            : ""}
      </p>
      {group.helped ? null : (
        <p className="auth__hint">The group's totals show once two other members have answered.</p>
      )}
    </Card>
  );
}
