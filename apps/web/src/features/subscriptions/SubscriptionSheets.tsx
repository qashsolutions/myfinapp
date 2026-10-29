import { Button, Sheet, Toggle } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useDb } from "../../data/DbProvider.tsx";
import type { RecurringSeries } from "../../data/db.ts";
import { parseWholeNumber } from "../../lib/ownValues.ts";
import { saveSetting } from "../bills/debtPlan.ts";
import { ChipsOrOwn, ChoiceChips } from "../goals/CustomValueSheet.tsx";
import {
  ASK_CHOICES,
  ASK_RANGE,
  ASK_SETTING,
  type CheckIntervals,
  DEFAULT_INTERVALS,
  kindLabel,
  OTHER_KIND,
  RENEWAL_CHOICES,
  RENEWAL_RANGE,
  RENEWAL_SETTING,
  setSubscriptionKind,
} from "./kinds.ts";
import {
  addOwnWord,
  checkKindName,
  checkWord,
  createOwnKind,
  KIND_NAME_MAX,
  kindChoices,
  normalizeWord,
  OwnKindError,
  suggestWord,
  updateOwnWord,
  useOwnKinds,
  WORD_MAX,
} from "./ownKinds.ts";

/** Where the person's own words and kinds are kept (Me → Money & data → Subscription words). */
export const WORDS_PATH = "/me/subscription-words";

function daysParser(range: { min: number; max: number }) {
  return (text: string) => {
    const n = parseWholeNumber(text, range.min, range.max);
    return n === null
      ? { error: `Pick a whole number of days from ${range.min} to ${range.max}.` }
      : { value: String(n) };
  };
}

/**
 * Adjust the subscription check (owner sign-off, October 29, 2026): how long before "Still using
 * it?" comes back, and how close a yearly or quarterly renewal shows. Kept in `settings`
 * (synced), passed to `recurring.subscription_check` over the config's defaults.
 */
export function AdjustCheckSheet({
  open,
  onClose,
  intervals,
}: {
  open: boolean;
  onClose: () => void;
  intervals: CheckIntervals;
}) {
  const { db } = useDb();
  return (
    <Sheet open={open} onClose={onClose} title="Adjust subscription check">
      <fieldset id="subs-adjust-ask" className="subs__adjust">
        <legend className="sr-only">Ask again</legend>
        <ChipsOrOwn
          name="subs-ask"
          legend="Ask “Still using it?” again after"
          options={ASK_CHOICES.map((d) => [String(d), `${d} days`])}
          value={String(intervals.askDays)}
          onPick={(v) => void saveSetting(db, ASK_SETTING, Number(v))}
          own={{
            label: "Your own number of days to ask again",
            placeholder: `${ASK_RANGE.min} to ${ASK_RANGE.max} days`,
            parse: daysParser(ASK_RANGE),
          }}
        />
      </fieldset>
      <fieldset id="subs-adjust-renewal" className="subs__adjust">
        <legend className="sr-only">Renewal heads-up</legend>
        <ChipsOrOwn
          name="subs-renewal"
          legend="Show a yearly or quarterly renewal this many days ahead"
          options={RENEWAL_CHOICES.map((d) => [String(d), `${d} days`])}
          value={String(intervals.renewalDays)}
          onPick={(v) => void saveSetting(db, RENEWAL_SETTING, Number(v))}
          own={{
            label: "Your own number of days before a renewal",
            placeholder: `${RENEWAL_RANGE.min} to ${RENEWAL_RANGE.max} days`,
            parse: daysParser(RENEWAL_RANGE),
          }}
        />
      </fieldset>
      <p className="auth__hint">
        Until you pick, Qash asks after {DEFAULT_INTERVALS.askDays} days and shows renewals{" "}
        {DEFAULT_INTERVALS.renewalDays} days ahead. Kept on this device and in your backups.
      </p>
      <p className="auth__hint">
        <Link to={WORDS_PATH} className="auth__link">
          Your subscription words and kinds
        </Link>{" "}
        · “When a charge says …, it's …”
      </p>
      <Button block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}

/** A new kind's name: 1 to 24 characters, checked before it saves. */
export function NewKindForm({
  onMade,
  submitLabel = "Add kind",
}: {
  onMade: (id: string, label: string) => void | Promise<void>;
  submitLabel?: string;
}) {
  const { db } = useDb();
  const ids = useId();
  const own = useOwnKinds();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState("");
  async function add() {
    const checked = checkKindName(name, own?.kinds ?? []);
    if ("problem" in checked) return setProblem(checked.problem);
    try {
      const made = await createOwnKind(db, checked.name);
      setName("");
      await onMade(made.id, made.label);
    } catch (e) {
      setProblem(e instanceof OwnKindError ? e.message : "That didn't save. Try again.");
    }
  }
  return (
    <form
      className="subs__form"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <label className="auth__field" htmlFor={`${ids}-name`}>
        <span className="auth__label">Name of the kind</span>
        <input
          id={`${ids}-name`}
          className="auth__input"
          value={name}
          maxLength={KIND_NAME_MAX + 8}
          autoComplete="off"
          placeholder="Like Kids, or Work tools"
          aria-describedby={problem ? `${ids}-problem` : `${ids}-hint`}
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
      ) : (
        <p className="auth__hint" id={`${ids}-hint`}>
          Up to {KIND_NAME_MAX} characters. Yours only, on this device and in your backups.
        </p>
      )}
      <Button block type="submit">
        {submitLabel}
      </Button>
    </form>
  );
}

/**
 * The kind picker: Qash's kinds, the person's own, Other (no kind), "+ New kind", and back to
 * the name's kind. "Also for future charges like this" saves a word too (prefilled from the
 * payee, editable), so the next charge with that word gets the same kind.
 */
export function KindSheet({
  series,
  kind,
  onClose,
  onDone,
}: {
  series: RecurringSeries | null;
  /** The kind shown now (the person's, else the name's). */
  kind: string | null;
  onClose: () => void;
  /** A short line for the screen's status after a pick. */
  onDone?: (text: string) => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const own = useOwnKinds();
  const [mode, setMode] = useState<"pick" | "new">("pick");
  const [also, setAlso] = useState(false);
  const [word, setWord] = useState("");
  const [problem, setProblem] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: start fresh for each subscription
  useEffect(() => {
    if (!series) return;
    setMode("pick");
    setAlso(false);
    setWord(suggestWord(series.payee));
    setProblem("");
  }, [series?.id]);

  const mine = series?.subscription_kind ?? null;
  const value = mine ?? kind ?? "";
  const labels = own?.labels;

  async function pick(v: string, label?: string) {
    if (!series) return;
    let saved: string | null = null;
    if (also && v !== OTHER_KIND) {
      const words = own?.words ?? [];
      // A word they already have is pointed at this kind instead of refused.
      const same = words.find((w) => w.match === normalizeWord(word));
      const checked = checkWord(word, words);
      try {
        if (same) await updateOwnWord(db, same.id, same.match, v);
        else if ("problem" in checked) return setProblem(checked.problem);
        else await addOwnWord(db, checked.match, v);
        saved = same?.match ?? ("match" in checked ? checked.match : null);
      } catch (e) {
        return setProblem(e instanceof OwnKindError ? e.message : "That didn't save. Try again.");
      }
    }
    await setSubscriptionKind(db, series.id, v);
    const name = v === OTHER_KIND ? "Other" : (label ?? kindLabel(v, labels));
    onDone?.(
      saved
        ? `${series.label} is now ${name}. Charges that say ${saved} will be too.`
        : `${series.label} is now ${name}.`,
    );
    onClose();
  }

  const title = series ? `What kind is ${series.label}?` : "What kind is it?";
  return (
    <Sheet open={series !== null} onClose={onClose} title={mode === "new" ? "New kind" : title}>
      {mode === "new" ? (
        <>
          <p className="auth__hint">
            Name a kind of your own. {series ? `${series.label} goes in it.` : ""}
          </p>
          <NewKindForm submitLabel="Add and use it" onMade={(id, label) => pick(id, label)} />
          {problem ? (
            <p className="auth__error" role="alert">
              {problem}
            </p>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setMode("pick")}>
            Back to the kinds
          </Button>
        </>
      ) : (
        <>
          <p className="auth__hint">
            Two or more of one kind are shown together. Your pick wins over the name.
          </p>
          <Toggle
            label="Also for future charges like this"
            description="A charge whose name has this word gets the same kind. Not for Other."
            checked={also}
            onChange={(on) => {
              setAlso(on);
              setProblem("");
            }}
          />
          {also ? (
            <label className="auth__field" htmlFor={`${ids}-word`}>
              <span className="auth__label">When a charge says</span>
              <input
                id={`${ids}-word`}
                className="auth__input"
                value={word}
                maxLength={WORD_MAX + 8}
                autoComplete="off"
                autoCapitalize="characters"
                aria-describedby={problem ? `${ids}-problem` : undefined}
                onChange={(e) => {
                  setWord(e.target.value);
                  setProblem("");
                }}
              />
            </label>
          ) : null}
          {problem ? (
            <p className="auth__error" id={`${ids}-problem`} role="alert">
              {problem}
            </p>
          ) : null}
          <ChoiceChips
            name="subs-kind"
            options={[...kindChoices(own?.kinds ?? []), [OTHER_KIND, "Other"]]}
            value={value === "" ? OTHER_KIND : value}
            onPick={(v) => void pick(v)}
          />
          <Button variant="secondary" size="sm" onClick={() => setMode("new")}>
            + New kind
          </Button>
          {mine !== null ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!series) return;
                await setSubscriptionKind(db, series.id, null);
                onClose();
              }}
            >
              Go back to the kind from its name
            </Button>
          ) : (
            <p className="auth__hint">Now: {kindLabel(kind, labels)}, from its name.</p>
          )}
          <p className="auth__hint">
            <Link to={WORDS_PATH} className="auth__link">
              Your subscription words
            </Link>
          </p>
        </>
      )}
    </Sheet>
  );
}
