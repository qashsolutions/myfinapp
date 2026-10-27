import "../auth/auth.css";
import "../entries/entries.css";

import { Button, List, ListRow } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useId, useState } from "react";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import type { Bucket, Category } from "../../data/db.ts";
import { forgetName } from "../entries/entryActions.ts";
import { CategorySheet } from "./CategorySheet.tsx";
import { BUCKET_LABEL, type CategoryKind, usageCounts } from "./categories.ts";

const BUCKETS: Bucket[] = ["need", "want", "save"];

/**
 * Me → Money & data → Categories (October 20, 2026): the built-in list plus your own, and since
 * October 23, 2026 the category rules and saved names that label entries.
 */
export function CategoriesScreen() {
  const { db } = useDb();
  const ids = useId();
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [sheet, setSheet] = useState<{ id: string | null } | null>(null);
  const all = useLiveQuery(() => db.categories.orderBy("[kind+sort]").toArray(), [db]);
  const uses = useLiveQuery(() => usageCounts(db), [db]);
  // How entries get labelled, all in one place (October 23, 2026): rules and saved names.
  const rules = useLiveQuery(() => db.merchant_rules.toArray(), [db]);
  const names = useLiveQuery(() => db.merchant_names.orderBy("match").toArray(), [db]);
  const nameOf = new Map((all ?? []).map((c) => [c.id, c.name]));
  const list = (all ?? []).filter((c) => c.kind === kind);
  const editing = sheet?.id ? ((all ?? []).find((c) => c.id === sheet.id) ?? null) : null;

  function row(c: Category) {
    const n = uses?.get(c.id) ?? 0;
    const bits = [
      c.is_default ? "Built-in" : "Yours",
      c.hidden ? "hidden" : null,
      n ? `${n} ${n === 1 ? "entry" : "entries"}` : null,
    ].filter(Boolean);
    return (
      <ListRow
        key={c.id}
        label={c.name}
        sublabel={bits.join(" · ")}
        valueTone="sub"
        chevron
        onClick={() => setSheet({ id: c.id })}
      />
    );
  }

  return (
    <>
      <ScreenHeader title="Categories" actions={null} back="/me/data" />
      <p className="auth__hint">
        Rename any, move it to another part of your budget, or add your own.
      </p>
      <fieldset className="segmented" style={{ border: 0, margin: 0 }}>
        <legend className="sr-only">Show</legend>
        {(
          [
            ["expense", "Money out"],
            ["income", "Money in"],
          ] as const
        ).map(([value, label]) => (
          <label className="segmented__option" key={value}>
            <input
              className="segmented__input"
              type="radio"
              name={`${ids}-kind`}
              checked={kind === value}
              onChange={() => setKind(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {kind === "expense" ? (
        BUCKETS.map((b) => {
          const inBucket = list.filter((c) => c.bucket === b);
          return inBucket.length ? (
            <section key={b} aria-labelledby={`${ids}-${b}`}>
              <h2 className="sk-card__eyebrow" id={`${ids}-${b}`}>
                {BUCKET_LABEL[b]}
              </h2>
              <List card>{inBucket.map(row)}</List>
            </section>
          ) : null;
        })
      ) : (
        <List card aria-label="Money-in categories">
          {list.map(row)}
        </List>
      )}
      <Button block variant="secondary" onClick={() => setSheet({ id: null })}>
        + New category
      </Button>
      {rules && rules.length > 0 ? (
        <section aria-labelledby={`${ids}-rules`}>
          <h2 className="sk-card__eyebrow" id={`${ids}-rules`}>
            Your rules
          </h2>
          <p className="auth__fineprint">
            Entries whose bank text contains these words get this category, now and on future
            imports.
          </p>
          <List card>
            {rules.map((r) => (
              <ListRow
                key={r.id}
                label={r.match}
                sublabel={`→ ${nameOf.get(r.category_id) ?? "a removed category"}`}
                value="Remove"
                valueTone="danger"
                onClick={() =>
                  void db.merchant_rules
                    .delete(r.id)
                    .then(() => recordDeletion(db, "merchant_rules", [r.id]))
                }
              />
            ))}
          </List>
        </section>
      ) : null}
      {names && names.length > 0 ? (
        <section aria-labelledby={`${ids}-names`}>
          <h2 className="sk-card__eyebrow" id={`${ids}-names`}>
            Your names
          </h2>
          <List card>
            {names.map((n) => (
              <ListRow
                key={n.id}
                label={n.name}
                sublabel={`For “${n.match}” · removing keeps the names entries already have`}
                value="Remove"
                valueTone="danger"
                onClick={() => void forgetName(db, n.id)}
              />
            ))}
          </List>
        </section>
      ) : null}
      <CategorySheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        kind={editing?.kind ?? kind}
        editing={editing}
        all={all ?? []}
        uses={editing ? (uses?.get(editing.id) ?? 0) : 0}
      />
    </>
  );
}
