import helpedCatalog from "@stackd/rules/helped";
import { Button, Card, ProgressBar } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { api, failureOf, type GroupDetail } from "../../data/api.ts";

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

/**
 * "What helped?" (docs/spec.md "Groups"; instead of a forum): once I reached my target or the
 * challenge ended, up to three choices from one fixed list, then the group's totals as bars
 * ("6 of 9 said Packed lunch"), shown only from two answers so no answer is anyone's.
 */
export function WhatHelped({ group, onSaved }: { group: GroupDetail; onSaved: () => void }) {
  const ids = useId();
  const [picked, setPicked] = useState<string[]>(group.my_helped);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  useEffect(() => setPicked(group.my_helped), [group.my_helped]);

  const full = picked.length >= HELPED.max_choices;
  const changed = picked.join(",") !== group.my_helped.join(",");
  const totals = group.helped
    ? Object.entries(group.helped.counts)
        .filter(([id]) => LABELS.has(id))
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
      <p>Pick up to {HELPED.max_choices}. The group sees totals only, never who chose what.</p>
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
          onSaved();
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
      {group.helped ? (
        <div className="helped-totals">
          {totals.map(([id, n]) => {
            const label = LABELS.get(id) ?? id;
            const of = group.helped?.answered ?? 0;
            return (
              <div key={id} className="helped-totals__row">
                <span>
                  {n} of {of} said {label}
                </span>
                <ProgressBar fraction={of ? n / of : 0} label={label} valueText={`${n} of ${of}`} />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="auth__hint">The group's totals show once two other members have answered.</p>
      )}
    </Card>
  );
}
