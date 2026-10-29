import "../auth/auth.css";
import "../entries/entries.css";
import "./subscriptions.css";

import { Button, Card, List, ListRow, Sheet } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useState } from "react";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { OwnSubscriptionKind, OwnSubscriptionWord } from "../../data/db.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";
import { KIND_TABLE, kindLabel } from "./kinds.ts";
import {
  addOwnWord,
  checkKindName,
  checkWord,
  KIND_NAME_MAX,
  kindChoices,
  MAX_OWN_KINDS,
  MAX_OWN_WORDS,
  OwnKindError,
  removeOwnKind,
  removeOwnWord,
  renameOwnKind,
  updateOwnWord,
  useOwnKinds,
  WORD_MAX,
} from "./ownKinds.ts";
import { NewKindForm } from "./SubscriptionSheets.tsx";

/** Add or edit one word: what the charge says, and the kind it means. */
function WordSheet({
  open,
  editing,
  kinds,
  words,
  onClose,
}: {
  open: boolean;
  editing: OwnSubscriptionWord | null;
  kinds: OwnSubscriptionKind[];
  words: OwnSubscriptionWord[];
  onClose: () => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const [text, setText] = useState("");
  const [kind, setKind] = useState("");
  const [problem, setProblem] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: start fresh each time it opens
  useEffect(() => {
    if (!open) return;
    setText(editing?.match ?? "");
    setKind(editing?.kind ?? "");
    setProblem("");
  }, [open]);

  async function save() {
    const checked = checkWord(text, words, editing?.id);
    if ("problem" in checked) return setProblem(checked.problem);
    if (!kind) return setProblem("Pick the kind it means.");
    try {
      if (editing) await updateOwnWord(db, editing.id, checked.match, kind);
      else await addOwnWord(db, checked.match, kind);
      onClose();
    } catch (e) {
      setProblem(e instanceof OwnKindError ? e.message : "That didn't save. Try again.");
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={editing ? `Edit ${editing.match}` : "Add a word"}>
      <label className="auth__field" htmlFor={`${ids}-word`}>
        <span className="auth__label">When a charge says</span>
        <input
          id={`${ids}-word`}
          className="auth__input"
          value={text}
          maxLength={WORD_MAX + 8}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="Like NETFLIX"
          aria-describedby={problem ? `${ids}-problem` : `${ids}-hint`}
          onChange={(e) => {
            setText(e.target.value);
            setProblem("");
          }}
        />
      </label>
      {problem ? (
        <p className="auth__error" id={`${ids}-problem`} role="alert">
          {problem}
        </p>
      ) : (
        <p className="auth__hint" id={`${ids}-hint`}>
          A whole word: GYM is in “GOLDS GYM” but not in “GYMBOREE”.
        </p>
      )}
      <fieldset className="subs__adjust">
        <legend className="auth__label">It's</legend>
        <ChoiceChips
          name={`${ids}-kinds`}
          options={kindChoices(kinds)}
          value={kind}
          onPick={(v) => {
            setKind(v);
            setProblem("");
          }}
        />
      </fieldset>
      <Button block onClick={() => void save()}>
        {editing ? "Save" : "Add word"}
      </Button>
      {editing ? (
        <Button
          block
          variant="ghost"
          onClick={async () => {
            await removeOwnWord(db, editing.id);
            onClose();
          }}
        >
          Remove {editing.match}
        </Button>
      ) : null}
    </Sheet>
  );
}

/** Rename or remove one of their kinds; removing sends its subscriptions back to their names. */
function KindEditSheet({
  editing,
  kinds,
  uses,
  wordsFor,
  onClose,
}: {
  editing: OwnSubscriptionKind | null;
  kinds: OwnSubscriptionKind[];
  uses: number;
  wordsFor: number;
  onClose: () => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  const [removing, setRemoving] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: start fresh for each kind
  useEffect(() => {
    setName(editing?.label ?? "");
    setProblem("");
    setRemoving(false);
  }, [editing?.id]);

  async function save() {
    if (!editing) return;
    const checked = checkKindName(name, kinds, editing.id);
    if ("problem" in checked) return setProblem(checked.problem);
    try {
      await renameOwnKind(db, editing.id, checked.name);
      onClose();
    } catch (e) {
      setProblem(e instanceof OwnKindError ? e.message : "That didn't save. Try again.");
    }
  }

  return (
    <Sheet
      open={editing !== null}
      onClose={onClose}
      title={editing ? `Edit ${editing.label}` : "Edit kind"}
    >
      {removing && editing ? (
        <>
          <p>
            {uses > 0
              ? `${uses} ${uses === 1 ? "subscription goes" : "subscriptions go"} back to the kind from ${uses === 1 ? "its" : "their"} name.`
              : "No subscription is in it now."}
            {wordsFor > 0
              ? ` ${wordsFor} ${wordsFor === 1 ? "word that means it goes" : "words that mean it go"} too.`
              : ""}
          </p>
          <Button
            block
            variant="danger"
            onClick={async () => {
              await removeOwnKind(db, editing.id);
              onClose();
            }}
          >
            Remove {editing.label}
          </Button>
          <Button block variant="ghost" onClick={() => setRemoving(false)}>
            Keep it
          </Button>
        </>
      ) : (
        <>
          <label className="auth__field" htmlFor={`${ids}-name`}>
            <span className="auth__label">Name of the kind</span>
            <input
              id={`${ids}-name`}
              className="auth__input"
              value={name}
              maxLength={KIND_NAME_MAX + 8}
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
          <Button block onClick={() => void save()}>
            Save
          </Button>
          <Button block variant="ghost" onClick={() => setRemoving(true)}>
            Remove {editing?.label}
          </Button>
        </>
      )}
    </Sheet>
  );
}

/**
 * Me → Money & data → Subscription words (owner decision, October 29, 2026): the person's own
 * "When a charge says …, it's …" words and their own kinds. Qash's list stays as it is; these
 * are checked before it, and a kind set on a subscription by hand still wins over both.
 */
export function SubscriptionWordsScreen() {
  const { db } = useDb();
  const own = useOwnKinds();
  const uses = useLiveQuery(async () => {
    const counts = new Map<string, number>();
    for (const s of await db.recurring_series.toArray())
      if (s.subscription_kind)
        counts.set(s.subscription_kind, (counts.get(s.subscription_kind) ?? 0) + 1);
    return counts;
  }, [db]);
  const [wordSheet, setWordSheet] = useState<{ id: string | null } | null>(null);
  const [kindEdit, setKindEdit] = useState<string | null>(null);
  const [newKind, setNewKind] = useState(false);
  const kinds = own?.kinds ?? [];
  const words = own?.words ?? [];
  const editingWord = wordSheet?.id ? (words.find((w) => w.id === wordSheet.id) ?? null) : null;
  const editingKind = kindEdit ? (kinds.find((k) => k.id === kindEdit) ?? null) : null;
  const wordCount = (kind: string) => words.filter((w) => w.kind === kind).length;

  return (
    <>
      <ScreenHeader
        title="Subscription words"
        back="/me/data"
        actions={
          <Button
            size="sm"
            variant="secondary"
            disabled={words.length >= MAX_OWN_WORDS}
            onClick={() => setWordSheet({ id: null })}
          >
            Add word
          </Button>
        }
      />
      <Card as="section" aria-label="How a kind is found">
        <Word>{words.length || kinds.length ? "Yours" : "Start"}</Word>
        <p>
          {words.length} {words.length === 1 ? "word" : "words"} · {kinds.length}{" "}
          {kinds.length === 1 ? "kind" : "kinds"} of your own
        </p>
        <p className="sk-card__eyebrow" id="subs-order-h">
          Which wins, first to last
        </p>
        <ol className="subs__order" aria-labelledby="subs-order-h">
          <li>
            <span className="subs__order-step">1</span>A kind you set on a subscription
          </li>
          <li>
            <span className="subs__order-step">2</span>Your words
          </li>
          <li>
            <span className="subs__order-step">3</span>Qash's {KIND_TABLE.length} words
          </li>
        </ol>
      </Card>

      <section aria-labelledby="subs-words-h">
        <h2 className="section-title" id="subs-words-h">
          Your words
        </h2>
        {words.length ? (
          <List card aria-label="Your words">
            {words.map((w) => (
              <ListRow
                key={w.id}
                label={w.match}
                sublabel={`It's ${kindLabel(w.kind, own?.labels)}`}
                chevron
                onClick={() => setWordSheet({ id: w.id })}
              />
            ))}
          </List>
        ) : (
          <Card>
            <p>
              No words yet. Add one, or turn on “Also for future charges like this” when you set a
              subscription's kind.
            </p>
          </Card>
        )}
        <p className="auth__fineprint">
          Up to {MAX_OWN_WORDS} words. Whole words only, the longest one first when two fit.
        </p>
      </section>

      <section aria-labelledby="subs-kinds-h">
        <h2 className="section-title" id="subs-kinds-h">
          Your kinds
        </h2>
        {kinds.length ? (
          <List card aria-label="Your kinds">
            {kinds.map((k) => {
              const n = uses?.get(k.id) ?? 0;
              const m = wordCount(k.id);
              return (
                <ListRow
                  key={k.id}
                  label={k.label}
                  sublabel={`${n} ${n === 1 ? "subscription" : "subscriptions"} · ${m} ${m === 1 ? "word" : "words"}`}
                  chevron
                  onClick={() => setKindEdit(k.id)}
                />
              );
            })}
          </List>
        ) : (
          <Card>
            <p>None yet. Qash's kinds cover the usual ones; add yours for anything else.</p>
          </Card>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={kinds.length >= MAX_OWN_KINDS}
          onClick={() => setNewKind(true)}
        >
          + New kind
        </Button>
        <p className="auth__fineprint">Up to {MAX_OWN_KINDS} kinds of your own.</p>
      </section>
      <p className="auth__fineprint">
        Kept on this device and in your encrypted backups. Never sent to Qash.
      </p>

      <WordSheet
        open={wordSheet !== null}
        editing={editingWord}
        kinds={kinds}
        words={words}
        onClose={() => setWordSheet(null)}
      />
      <KindEditSheet
        editing={editingKind}
        kinds={kinds}
        uses={editingKind ? (uses?.get(editingKind.id) ?? 0) : 0}
        wordsFor={editingKind ? wordCount(editingKind.id) : 0}
        onClose={() => setKindEdit(null)}
      />
      <Sheet open={newKind} onClose={() => setNewKind(false)} title="New kind">
        <NewKindForm onMade={() => setNewKind(false)} />
      </Sheet>
    </>
  );
}
