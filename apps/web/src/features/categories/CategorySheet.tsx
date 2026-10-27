import "../auth/auth.css";
import "../entries/entries.css";

import { Button, Sheet, Toggle } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { Bucket, Category } from "../../data/db.ts";
import {
  BUCKET_LABEL,
  type CategoryKind,
  checkName,
  createCategory,
  NAME_MAX,
  NAME_PROBLEM,
  removeCategory,
  updateCategory,
} from "./categories.ts";

const BUCKETS: Bucket[] = ["need", "want", "save"];

/**
 * New or edit one category: its name, its part of the budget (money out), Hide for a built-in
 * one, Remove for your own (its entries move to the category you pick first).
 */
export function CategorySheet({
  open,
  onClose,
  kind,
  editing,
  all,
  uses = 0,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  kind: CategoryKind;
  /** The category being edited; none means a new one. */
  editing?: Category | null;
  all: Category[];
  uses?: number;
  onCreated?: (category: Category) => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const [name, setName] = useState("");
  const [bucket, setBucket] = useState<Bucket>("want");
  const [problem, setProblem] = useState("");
  const [removing, setRemoving] = useState(false);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: start fresh each time the sheet opens
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setBucket(editing?.bucket ?? "want");
    setProblem("");
    setRemoving(false);
    setMoveTo(null);
  }, [open]);

  const targets = all.filter((c) => c.kind === kind && c.id !== editing?.id && !c.hidden);

  async function save() {
    const checked = checkName(name, kind, all, editing?.id);
    if ("problem" in checked) return setProblem(NAME_PROBLEM[checked.problem]);
    try {
      if (editing) {
        await updateCategory(db, editing.id, { name: checked.name, bucket });
      } else {
        const made = await createCategory(db, { name: checked.name, kind, bucket });
        onCreated?.(made);
      }
      onClose();
    } catch (e) {
      setProblem(
        e instanceof Error && e.message === "too_many"
          ? "You have as many of your own categories as Qash keeps. Remove one first."
          : "That didn't save. Try again.",
      );
    }
  }

  async function remove() {
    if (!editing || !moveTo) return;
    await removeCategory(db, editing.id, moveTo);
    onClose();
  }

  const title = editing
    ? `Edit ${editing.name}`
    : kind === "expense"
      ? "New category"
      : "New money-in category";
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {removing && editing ? (
        <>
          <p>
            {uses > 0
              ? `Move its ${uses} ${uses === 1 ? "entry" : "entries"}, rules and plan to:`
              : "Move its rules and plan to:"}
          </p>
          <fieldset className="chips" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="sr-only">Move to</legend>
            {targets.map((c) => (
              <label className="chip-option" key={c.id}>
                <input
                  className="segmented__input"
                  type="radio"
                  name={`${ids}-move`}
                  checked={moveTo === c.id}
                  onChange={() => setMoveTo(c.id)}
                />
                {c.name}
              </label>
            ))}
          </fieldset>
          <p className="auth__fineprint">Totals don't change; only the category they show under.</p>
          <Button block variant="danger" disabled={!moveTo} onClick={() => void remove()}>
            Move and remove {editing.name}
          </Button>
          <Button block variant="ghost" onClick={() => setRemoving(false)}>
            Keep it
          </Button>
        </>
      ) : (
        <>
          <label className="auth__field" htmlFor={`${ids}-name`}>
            <span className="auth__label">Name</span>
            <input
              id={`${ids}-name`}
              className="auth__input"
              value={name}
              maxLength={NAME_MAX + 8}
              autoComplete="off"
              aria-describedby={problem ? `${ids}-problem` : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setProblem("");
              }}
            />
          </label>
          {problem ? (
            <p className="auth__error" id={`${ids}-problem`} role="alert">
              {problem}
            </p>
          ) : null}
          {kind === "expense" ? (
            <fieldset className="chips" style={{ border: 0, margin: 0, padding: 0 }}>
              <legend className="auth__label">Part of your budget</legend>
              {BUCKETS.map((b) => (
                <label className="chip-option" key={b}>
                  <input
                    className="segmented__input"
                    type="radio"
                    name={`${ids}-bucket`}
                    checked={bucket === b}
                    onChange={() => setBucket(b)}
                  />
                  {BUCKET_LABEL[b]}
                </label>
              ))}
            </fieldset>
          ) : null}
          {editing?.is_default ? (
            <Toggle
              label="Show when picking a category"
              description="Hidden, it stays on the entries already in it"
              checked={!editing.hidden}
              onChange={(on) => void updateCategory(db, editing.id, { hidden: !on })}
            />
          ) : null}
          <Button block onClick={() => void save()}>
            {editing ? "Save" : "Add category"}
          </Button>
          {editing && !editing.is_default ? (
            <Button block variant="ghost" onClick={() => setRemoving(true)}>
              Remove {editing.name}
            </Button>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
