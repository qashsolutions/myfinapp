import "./budget.css";

import { Button, Sheet, Toggle } from "@stackd/ui";
import { useId } from "react";
import type { NotificationSettingsOut, NotificationSettingsPatch } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { parseWholeNumber } from "../../lib/ownValues.ts";
import { saveSetting } from "../bills/debtPlan.ts";
import { ChipsOrOwn } from "../goals/CustomValueSheet.tsx";
import { ALERT_OFF_SETTING } from "./pace.ts";

type Prefs = NotificationSettingsOut["prefs"];

/**
 * The budget alert's level and time (owner sign-off, October 29, 2026: 90% or 100%, or the
 * person's own whole percent from 50 to 150; 09:00 unless chosen). One copy for Me → Alerts and
 * Budget's Adjust sheet, so both save the same preference.
 */
export function BudgetAlertOptions({
  prefs,
  update,
}: {
  prefs: Prefs;
  update: (patch: NotificationSettingsPatch) => Promise<void>;
}) {
  const ids = useId();
  return (
    <>
      <ChipsOrOwn
        name={`${ids}-budget-level`}
        legend="Tell me at"
        options={[
          ["90", "90%"],
          ["100", "100%"],
        ]}
        value={String(prefs.budget_pace?.threshold ?? 90)}
        onPick={(v) => void update({ prefs: { budget_pace: { threshold: Number(v) } } })}
        own={{
          label: "Your own percent of the plan, 50 to 150",
          placeholder: "Or your own: 50 to 150%",
          parse: (t) => {
            const n = parseWholeNumber(t.replace("%", ""), 50, 150);
            return n === null
              ? { error: "Pick a whole percent from 50 to 150." }
              : { value: String(n) };
          },
        }}
      />
      <p className="auth__hint">
        Once per category each month. The alert never names the category or an amount.
      </p>
      <label className="auth__field">
        <span className="auth__label">Budget alert time</span>
        <input
          className="auth__input"
          type="time"
          defaultValue={prefs.budget_pace?.time_of_day ?? "09:00"}
          onBlur={(e) =>
            e.target.value &&
            void update({ prefs: { budget_pace: { time_of_day: e.target.value } } })
          }
        />
      </label>
    </>
  );
}

/**
 * Budget's "Adjust budget alerts" (October 29, 2026): the alert on or off, its level and time,
 * and one switch per budget line ("Alert me for Dining"). A line switched off keeps its word
 * on Budget and makes no alert (`settings` `budget.alert_off`, synced).
 */
export function AdjustBudgetAlerts({
  open,
  onClose,
  prefs,
  update,
  lines,
  off,
}: {
  open: boolean;
  onClose: () => void;
  prefs: Prefs | null;
  update: (patch: NotificationSettingsPatch) => Promise<void>;
  lines: Array<{ id: string; name: string }>;
  off: readonly string[];
}) {
  const { db } = useDb();
  const enabled = prefs?.budget_pace?.enabled ?? false;
  async function setLine(id: string, alertMe: boolean) {
    const next = alertMe ? off.filter((x) => x !== id) : [...off.filter((x) => x !== id), id];
    await saveSetting(db, ALERT_OFF_SETTING, next);
  }
  return (
    <Sheet open={open} onClose={onClose} title="Adjust budget alerts">
      {prefs ? (
        <>
          <Toggle
            label="Budget alert"
            description="When a line gets close to its plan"
            checked={enabled}
            onChange={(checked) => void update({ prefs: { budget_pace: { enabled: checked } } })}
          />
          {enabled ? <BudgetAlertOptions prefs={prefs} update={update} /> : null}
        </>
      ) : (
        <p className="auth__hint">Alert settings load when you're online.</p>
      )}
      {lines.length ? (
        <>
          <p className="auth__label">Lines that alert</p>
          <ul className="alert-lines">
            {lines.map((l) => (
              <li key={l.id}>
                <Toggle
                  label={`Alert me for ${l.name}`}
                  checked={!off.includes(l.id)}
                  onChange={(checked) => void setLine(l.id, checked)}
                />
              </li>
            ))}
          </ul>
          <p className="auth__hint">A line switched off still shows Close and Over here.</p>
        </>
      ) : null}
      <Button block onClick={onClose}>
        Done
      </Button>
    </Sheet>
  );
}
