import { Button, Card, Toggle } from "@stackd/ui";
import { useCallback, useEffect, useId, useState } from "react";
import { Word } from "../../app/layout/Word.tsx";
import { api, failureOf, failureText } from "../../data/api.ts";
import { formatDateTime } from "../../lib/format.ts";
import { useStepUp } from "./StepUpPrompt.tsx";

/*
 * Getting back in without a passkey (owner decision, October 30, 2026; invariant 74), the
 * parts on a device that is signed in: the owner's Cancel, the partner's approval, and the
 * switch that lets the partner approve.
 */

/** Sign-in & security: someone asked to get back into this account; Cancel ends it. */
export function PendingRecovery() {
  const [readyAt, setReadyAt] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.GET("/api/auth/recovery").then((r) => {
      if (!alive || !r.data) return;
      setWaiting(r.data.status !== "none");
      setReadyAt(r.data.ready_at ?? null);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function cancel() {
    const r = await api.POST("/api/auth/recovery/cancel");
    const failure = failureOf(r);
    if (failure) {
      setNote(failureText(failure, "Couldn't cancel. Try again."));
      return;
    }
    setWaiting(false);
    setNote("Cancelled. Nothing changed.");
  }

  if (!waiting)
    return note ? (
      <p className="auth__hint" role="status">
        {note}
      </p>
    ) : null;
  return (
    <Card as="div" role="alert" aria-label="Someone asked to get back in">
      <Word>Review</Word>
      <p>Someone asked to get back into your account without a passkey.</p>
      <p className="group-row__meta">
        It goes through {readyAt ? `on ${formatDateTime(readyAt)}` : "in 24 hours"} unless you
        cancel it. Leave it only if it was you, on another device.
      </p>
      <Button onClick={cancel}>Cancel it</Button>
      {note ? <p className="auth__error">{note}</p> : null}
    </Card>
  );
}

type Asked = { id: string; name: string; device_label: string; asked_at: string };

/** Household: the partner asked for help getting back in; type the code they read out. */
export function RecoveryRequests() {
  const stepUp = useStepUp();
  const ids = useId();
  const [asked, setAsked] = useState<Asked[]>([]);
  const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.GET("/api/household/recovery");
    if (r.data) setAsked(r.data as Asked[]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function approve() {
    setNote(null);
    if (!(await stepUp.confirm("Letting your partner back in"))) return;
    const r = await api.POST("/api/household/recovery/approve", { body: { code } });
    const failure = failureOf(r);
    if (failure) {
      setNote(
        failure.code === "wrong_code" && failure.attemptsLeft
          ? `That code doesn't match. Ask them to read it again (${failure.attemptsLeft} ${failure.attemptsLeft === 1 ? "try" : "tries"} left).`
          : failure.code === "wrong_code" || failure.code === "not_found"
            ? "That code has stopped working. Ask them to tap Ask my partner again for a new one."
            : failureText(failure, "Couldn't approve. Try again."),
      );
      await load();
      return;
    }
    setDone(r.data?.name ?? "Your partner");
    setCode("");
    await load();
  }

  if (done && asked.length === 0)
    return (
      <p className="auth__hint" role="status">
        Done. {done} can create a new passkey now.
      </p>
    );
  const first = asked[0];
  if (!first) return null;
  return (
    <Card as="div" role="alert" aria-label={`${first.name} asked for help getting back in`}>
      <Word>Review</Word>
      <p>{first.name} asked you to help them get back into Qash.</p>
      <p className="group-row__meta">
        Only approve if you're talking to {first.name} now. Type the code their screen shows.
      </p>
      <label className="auth__field" htmlFor={`${ids}-code`}>
        <span className="auth__label">Their code</span>
        <input
          id={`${ids}-code`}
          className="auth__input"
          inputMode="numeric"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <Button onClick={approve} disabled={code.replace(/\D/g, "").length !== 6}>
        Let {first.name} in
      </Button>
      {note ? (
        <p className="auth__error" role="alert">
          {note}
        </p>
      ) : null}
    </Card>
  );
}

type Setting = { on: boolean; possible: boolean; partner_name?: string | null };

/** Household: "Let <partner> help me get back in", only while both share the one plan. */
export function RecoveryPartnerSwitch() {
  const stepUp = useStepUp();
  const [setting, setSetting] = useState<Setting | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.GET("/api/account/recovery-partner").then((r) => {
      if (alive && r.data) setSetting(r.data as Setting);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function change(on: boolean) {
    setNote(null);
    if (!(await stepUp.confirm(on ? "Letting your partner help you back in" : "Turning that off")))
      return;
    const r = await api.PUT("/api/account/recovery-partner", { body: { on } });
    const failure = failureOf(r);
    if (failure) {
      setNote(failureText(failure, "Couldn't save. Try again."));
      return;
    }
    setSetting(r.data as Setting);
  }

  if (!setting?.possible) return null;
  const name = setting.partner_name ?? "your partner";
  return (
    <Card as="section" aria-label="Getting back in">
      <Toggle
        checked={setting.on}
        onChange={(on) => void change(on)}
        label={`Let ${name} help me get back in`}
        description={`If you ever lose every passkey, ${name} can let you back in from their Qash after you read them a code. Without this, it takes 24 hours.`}
      />
      {note ? (
        <p className="auth__error" role="alert">
          {note}
        </p>
      ) : null}
    </Card>
  );
}
