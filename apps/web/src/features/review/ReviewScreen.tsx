import "../entries/entries.css";
import "../auth/auth.css";
import "./review.css";

import { Button, Card, Chip, Illustration, ProgressBar, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { Entry } from "../../data/db.ts";
import { cleanDescription, suggestCategory } from "../../engine/bridge.ts";
import { formatCents, formatDay } from "../../lib/format.ts";
import { CategorySheet } from "../categories/CategorySheet.tsx";
import { markTransfers } from "../entries/transfers.ts";
import { showUndo } from "../entries/undoToast.ts";
import { accountLabel, useLookups } from "../entries/useEntries.ts";
import { alikeIds, markAll, ruleText, sortEntry, toReview, unsort } from "./review.ts";

/**
 * Sort what isn't sorted (owner sign-off October 19, 2026, item 9; built October 20, 2026): one
 * entry at a time, newest first. Pick a category (the bundled model's suggestion comes first
 * when it has one), and optionally sort every entry like it and remember it for future imports.
 * Also: it's a transfer, don't count it, or skip for now.
 */
export function ReviewScreen() {
  const { db } = useDb();
  const lookups = useLookups();
  const queue = useLiveQuery(() => toReview(db), [db]);
  const categories = useLiveQuery(() => db.categories.orderBy("[kind+sort]").toArray(), [db]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [sortedCount, setSortedCount] = useState(0);
  const [startCount, setStartCount] = useState<number | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [alike, setAlike] = useState(0);
  const [remember, setRemember] = useState(true);
  const [adding, setAdding] = useState(false);

  const waiting = (queue ?? []).filter((e) => !skipped.includes(e.id));
  const current: Entry | undefined = waiting[0];
  useEffect(() => {
    if (queue && startCount === null) setStartCount(queue.length);
  }, [queue, startCount]);

  // For the entry on screen: the model's suggestion and how many others look the same.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute only when the entry changes
  useEffect(() => {
    setSuggested(null);
    setAlike(0);
    if (!current) return;
    let alive = true;
    void (async () => {
      const text = ruleText(current);
      const mine = await cleanDescription(text);
      let same = 0;
      for (const e of queue ?? []) {
        if (e.id === current.id || e.direction !== current.direction) continue;
        if ((await cleanDescription(ruleText(e))).includes(mine)) same += 1;
      }
      const s = current.direction === "out" ? await suggestCategory(text) : null;
      if (!alive) return;
      setAlike(same);
      setRemember(same > 0);
      setSuggested(s?.category_id ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [current?.id]);

  const kind = current?.direction === "in" ? "income" : "expense";
  const choices = useMemo(() => {
    const list = (categories ?? []).filter((c) => c.kind === kind && !c.hidden);
    const first = list.find((c) => c.id === suggested);
    return first ? [first, ...list.filter((c) => c !== first)] : list;
  }, [categories, kind, suggested]);

  async function choose(categoryId: string) {
    if (!current) return;
    const done = await sortEntry(db, current, categoryId, remember);
    setSortedCount((c) => c + done.ids.length);
    const name = categories?.find((c) => c.id === categoryId)?.name ?? "that category";
    showUndo(
      done.ids.length > 1 ? `${done.ids.length} sorted into ${name}` : `Sorted into ${name}`,
      () => void unsort(db, done),
    );
  }

  async function asTransfer() {
    if (!current) return;
    // Both sides: the other side of each is marked and paired too (October 27, 2026).
    const ids = [current.id, ...(remember && alike > 0 ? await alikeIds(db, current) : [])];
    const done = await markTransfers(db, ids);
    // Count what was marked: each entry's other side too, and none already a transfer.
    const marked = done.ids.length;
    setSortedCount((c) => c + marked);
    showUndo(
      marked > 1 ? `${marked} marked as transfers` : "Marked as a transfer",
      () => void done.undo(),
    );
  }

  async function dontCount() {
    if (!current) return;
    const ids = await markAll(db, current, { not_counted: true }, remember && alike > 0);
    setSortedCount((c) => c + ids.length);
    showUndo(
      ids.length > 1 ? `${ids.length} not counted in spending` : "Not counted in spending",
      () => void db.entries.where("id").anyOf(ids).modify({ not_counted: false }),
    );
  }

  const total = startCount ?? 0;
  const left = waiting.length;
  return (
    <>
      <ScreenHeader title="Sort your spending" back="/insights" actions={null} />
      {queue === undefined ? null : !current ? (
        <Card>
          <Illustration name="sprout" tone="a2" />
          <Word>{skipped.length > 0 ? "Done" : "Sorted"}</Word>
          <p className="review__done">
            {skipped.length > 0
              ? `Done for now. ${skipped.length} skipped; they'll be here next time.`
              : "Everything is sorted."}
          </p>
          <p>
            <Link to="/money">See where it went</Link>
          </p>
        </Card>
      ) : (
        <>
          <ProgressBar
            fraction={total ? (total - left) / total : 0}
            label="Sorted"
            valueText={`${left} left`}
          />
          <p className="review__left" aria-live="polite">
            {left} left{sortedCount ? ` · ${sortedCount} sorted` : ""}
          </p>
          <Card as="section" aria-label="To sort" className="review__card">
            <p className="review__merchant">{current.merchant}</p>
            <p
              className={`review__amount${current.direction === "in" ? " review__amount--in" : ""}`}
            >
              {formatCents(current.amount_cents, current.direction)}
            </p>
            <p className="review__meta">
              {formatDay(current.date)} · {accountLabel(lookups?.accounts.get(current.account_id))}
              {current.raw_description && current.raw_description !== current.merchant
                ? ` · “${current.raw_description}”`
                : ""}
            </p>
            <fieldset className="chips review__chips" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="review__ask">Which category?</legend>
              {choices.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`chip-option${c.id === suggested ? " review__suggested" : ""}`}
                  onClick={() => void choose(c.id)}
                >
                  {c.name}
                  {c.id === suggested ? <span className="sr-only"> (suggested)</span> : null}
                </button>
              ))}
              <button type="button" className="chip-option" onClick={() => setAdding(true)}>
                + New
              </button>
            </fieldset>
            {suggested ? (
              <p className="auth__fineprint">
                <Chip tone="accent">Suggested</Chip> from the name, on this device. You decide.
              </p>
            ) : null}
            <Toggle
              label={
                alike > 0
                  ? `Do the same for all ${alike + 1} like this`
                  : "Always put this one there"
              }
              description={
                alike > 0
                  ? "A category also becomes a rule, so future imports are sorted too"
                  : "Becomes one of your category rules; future imports use it"
              }
              checked={remember}
              onChange={setRemember}
            />
          </Card>
          <div className="review__more">
            <Button variant="secondary" onClick={() => void asTransfer()}>
              It's a transfer
            </Button>
            <Button variant="secondary" onClick={() => void dontCount()}>
              Don't count
            </Button>
            <Button variant="ghost" onClick={() => setSkipped((s) => [...s, current.id])}>
              Skip for now
            </Button>
          </div>
          <CategorySheet
            open={adding}
            onClose={() => setAdding(false)}
            kind={kind}
            all={categories ?? []}
            onCreated={(c) => void choose(c.id)}
          />
        </>
      )}
    </>
  );
}
