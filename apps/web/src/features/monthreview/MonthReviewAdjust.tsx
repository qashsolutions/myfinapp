import { Button, Sheet, Toggle } from "@stackd/ui";
import { useDb } from "../../data/DbProvider.tsx";
import { ignoreClosed } from "../../data/db.ts";
import { parseWholeNumber } from "../../lib/ownValues.ts";
import { ChipsOrOwn } from "../goals/CustomValueSheet.tsx";
import {
  HOME_CARD_KEY,
  type MonthReviewPrefs,
  SHOW_DAYS_CHOICES,
  SHOW_DAYS_KEY,
  SHOW_DAYS_MAX,
  saveReviewPref,
} from "./monthReview.ts";

function daysText(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/**
 * Adjust Your month (October 29, 2026): whether Home shows the card and for how many days at
 * the start of a month (3 / 7 / 14 or the person's own 1 to 28; 7 until they pick, signed off by
 * the owner, October 29, 2026). Kept in `settings`, synced like other settings.
 */
export function MonthReviewAdjust({
  open,
  onClose,
  prefs,
}: {
  open: boolean;
  onClose: () => void;
  prefs: MonthReviewPrefs | undefined;
}) {
  const { db } = useDb();
  const save = (key: string, value: unknown) => {
    void saveReviewPref(db, key, value).catch(ignoreClosed);
  };
  return (
    <Sheet open={open} onClose={onClose} title="Adjust Your month">
      {prefs ? (
        <>
          <Toggle
            checked={prefs.homeCard}
            onChange={(on) => save(HOME_CARD_KEY, on)}
            label="Show on Home"
            description="A card at the start of each month for the month just ended"
          />
          <ChipsOrOwn
            name="review-days"
            legend="For how many days of the month"
            options={SHOW_DAYS_CHOICES.map((n) => [String(n), daysText(n)])}
            value={String(prefs.showDays)}
            display={(v) => v}
            onPick={(v) => save(SHOW_DAYS_KEY, Number(v))}
            own={{
              label: "Your own number of days",
              placeholder: `1 to ${SHOW_DAYS_MAX}`,
              parse: (text) => {
                const n = parseWholeNumber(text, 1, SHOW_DAYS_MAX);
                return n === null
                  ? { error: `Enter a whole number of days from 1 to ${SHOW_DAYS_MAX}.` }
                  : { value: String(n) };
              },
            }}
          />
          {prefs.homeCard ? null : (
            <p className="auth__fineprint">
              Off: Your month stays on Insights; Home doesn't show it.
            </p>
          )}
        </>
      ) : null}
      <div className="install-actions">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Sheet>
  );
}
