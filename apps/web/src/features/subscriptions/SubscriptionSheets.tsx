import { Button, Sheet } from "@stackd/ui";
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
  KIND_NAMES,
  kindLabel,
  OTHER_KIND,
  RENEWAL_CHOICES,
  RENEWAL_RANGE,
  RENEWAL_SETTING,
  setSubscriptionKind,
} from "./kinds.ts";

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
      <Button block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}

/** The kind picker: the fixed kinds plus Other (no kind), and back to the name's kind. */
export function KindSheet({
  series,
  kind,
  onClose,
}: {
  series: RecurringSeries | null;
  /** The kind shown now (the person's, else the name's). */
  kind: string | null;
  onClose: () => void;
}) {
  const { db } = useDb();
  const own = series?.subscription_kind ?? null;
  const value = own ?? kind ?? "";
  return (
    <Sheet
      open={series !== null}
      onClose={onClose}
      title={series ? `What kind is ${series.label}?` : "What kind is it?"}
    >
      <p className="auth__hint">
        Two or more of one kind are shown together. Your pick wins over the name.
      </p>
      <ChoiceChips
        name="subs-kind"
        options={[
          ...KIND_NAMES.map((k): [string, string] => [k.kind, k.label]),
          [OTHER_KIND, "Other"],
        ]}
        value={value === "" ? OTHER_KIND : value}
        onPick={async (v) => {
          if (!series) return;
          await setSubscriptionKind(db, series.id, v);
          onClose();
        }}
      />
      {own !== null ? (
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
        <p className="auth__hint">Now: {kindLabel(kind)}, from its name.</p>
      )}
    </Sheet>
  );
}
