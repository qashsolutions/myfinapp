import { Button, Card } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { api, failureOf } from "../../data/api.ts";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "./StepUpPrompt.tsx";

export const LOCK_MIN = 5;
export const LOCK_MAX = 60;

/** Whole minutes from 5 to 60, typed as digits only; anything else is null. */
export function parseLockMinutes(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= LOCK_MIN && n <= LOCK_MAX ? n : null;
}

/**
 * Sign-in & security → Auto-lock (owner decision, October 12, 2026): lock after 5 to 60 idle
 * minutes. Drag the slider or type the number; Save asks for the passkey (a longer lock is a
 * weaker lock) and the server enforces the same window on every device.
 */
export function AutoLockSetting() {
  const session = useSession();
  const stepUp = useStepUp();
  const saved = Math.round((session.info?.lock_after_seconds ?? 300) / 60);
  const [text, setText] = useState(String(saved));
  // Once the person has typed or dragged, a background session refresh never overwrites it.
  const [edited, setEdited] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = useId();
  useEffect(() => {
    if (!edited) setText(String(saved));
  }, [saved, edited]);
  const edit = (value: string) => {
    setEdited(true);
    setText(value);
  };

  const minutes = parseLockMinutes(text);
  const changed = minutes !== null && minutes !== saved;

  async function save() {
    if (minutes === null) return;
    setNotice(null);
    if (!(await stepUp.confirm("Changing when the app locks"))) return;
    setBusy(true);
    const r = await api.PUT("/api/security/lock", { body: { minutes } });
    setBusy(false);
    if (failureOf(r)) {
      setNotice("Couldn't save that. Try again.");
      return;
    }
    await session.refresh();
    setEdited(false); // saved: follow the server again
    setNotice(`Saved. Locks after ${minutes} minutes without activity.`);
  }

  return (
    <section aria-labelledby={`${ids}-h`}>
      <h2 className="section-title" id={`${ids}-h`}>
        Auto-lock
      </h2>
      <Card className="autolock">
        <p className="autolock__value" aria-hidden="true">
          {minutes ?? "–"}
          <span> min</span>
        </p>
        <div className="autolock__controls">
          <input
            className="autolock__slider"
            type="range"
            min={LOCK_MIN}
            max={LOCK_MAX}
            step={1}
            value={minutes ?? saved}
            aria-label="Lock after, in minutes"
            aria-valuetext={`${minutes ?? saved} minutes`}
            onChange={(e) => edit(e.target.value)}
          />
          <label className="autolock__field">
            <span className="sr-only">Minutes, from 5 to 60</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={2}
              value={text}
              aria-invalid={minutes === null}
              aria-describedby={`${ids}-help`}
              onChange={(e) => edit(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <span aria-hidden="true">min</span>
          </label>
        </div>
        <p id={`${ids}-help`} className={minutes === null ? "auth__error" : "autolock__help"}>
          {minutes === null
            ? "Pick a whole number from 5 to 60."
            : "Locks this app after that many minutes without activity, on every device."}
        </p>
        {changed ? (
          <Button block onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
      </Card>
    </section>
  );
}
