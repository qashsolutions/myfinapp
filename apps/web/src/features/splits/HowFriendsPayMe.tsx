import "./splits.css";
import "../auth/auth.css";

import { Button, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "../security/StepUpPrompt.tsx";
import type { HandleApp } from "./ledger.ts";
import { APP_NAME, cleanHandle, HANDLE_APPS, handleHint } from "./payLinks.ts";
import { updateMyProfile } from "./splitSync.ts";
import { useSplits, useSplitViews } from "./useSplits.ts";

/**
 * How friends pay me (spec "Payment handles"): the person's own Venmo, Cash App and PayPal, saved
 * after a passkey check into their encrypted profile in every group they're in. Nobody else can
 * change them; a changed handle shows "Changed recently" on everyone's pay screen for 3 days.
 */
export function HowFriendsPayMe() {
  const { db } = useDb();
  const { info } = useSession();
  const stepUp = useStepUp();
  const { splits } = useSplits();
  const views = useSplitViews(splits?.groups ?? null, false);
  const [typed, setTyped] = useState<Record<HandleApp, string>>({
    venmo: "",
    cashapp: "",
    paypal: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Start from what I saved in any group (they're all the same unless a save was cut short).
  useEffect(() => {
    if (loaded || !splits) return;
    for (const g of splits.groups) {
      const mine = views.get(g.id)?.profiles.get(g.my_member_id);
      if (mine) {
        setTyped({
          venmo: mine.handles.venmo ?? "",
          cashapp: mine.handles.cashapp ?? "",
          paypal: mine.handles.paypal ?? "",
        });
        setLoaded(true);
        return;
      }
    }
  }, [splits, views, loaded]);

  async function save() {
    if (!splits) return;
    const handles: Partial<Record<HandleApp, string>> = {};
    for (const [app] of HANDLE_APPS) {
      const clean = cleanHandle(app, typed[app]);
      if (clean === null) return setError(handleHint(app));
      if (clean) handles[app] = clean;
    }
    setError(null);
    if (!(await stepUp.confirm("Save how friends pay you"))) return;
    setBusy(true);
    const now = new Date().toISOString();
    const name = info?.user?.display_name ?? "";
    let saved = 0;
    let waiting = 0;
    for (const g of splits.groups) {
      const r = await updateMyProfile(db, g.id, g.my_member_id, (old) => {
        const changed = { ...(old?.changed ?? {}) };
        for (const [app] of HANDLE_APPS)
          if ((old?.handles[app] ?? "") !== (handles[app] ?? "")) changed[app] = now;
        return { v: 1, name, handles, changed, saved_at: now };
      });
      if (r === "ok") saved += 1;
      else if (r === "no_key") waiting += 1;
    }
    setBusy(false);
    const failed = splits.groups.length - saved - waiting;
    setNote(
      splits.groups.length === 0
        ? "Join a group first; your handles are saved into each group you're in."
        : `Saved in ${saved} ${saved === 1 ? "group" : "groups"}.${
            waiting ? ` ${waiting} still waiting for the group's key.` : ""
          }${failed ? ` ${failed} couldn't be reached; try again online.` : ""}`,
    );
  }

  return (
    <>
      <ScreenHeader title="How friends pay me" actions={null} back="/me" />
      <Card>
        <p>
          When someone in your groups owes you, Pay opens your app with the amount. Only you can
          change these, after Face ID or your passkey.
        </p>
      </Card>
      {HANDLE_APPS.map(([app, label]) => (
        <label className="auth__field" key={app}>
          <span className="auth__label">{label}</span>
          <input
            className="auth__input"
            autoComplete="off"
            placeholder={
              app === "venmo" ? "@your-name" : app === "cashapp" ? "$yourname" : "yourname"
            }
            value={typed[app]}
            onChange={(e) => setTyped((t) => ({ ...t, [app]: e.target.value }))}
          />
        </label>
      ))}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}
      <Button block onClick={save} disabled={busy || !splits}>
        Save
      </Button>
      <p className="auth__fineprint">
        Encrypted on this device for your groups only. Qash never moves money.{" "}
        {Object.values(APP_NAME).join(", ")} are their own companies.
      </p>
    </>
  );
}
