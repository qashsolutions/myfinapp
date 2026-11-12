import type { components } from "@stackd/api-client";
import { Button, Card, Sheet } from "@stackd/ui";
import { useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { dayOf, formatDay } from "../../lib/format.ts";
import { canRemindNow, rememberInvite, useInvitedEmails } from "./invited.ts";
import { cancelInvite, checkInvite, remindInvite, splitErrorText } from "./useSplits.ts";

type SplitGroupOut = components["schemas"]["SplitGroupOut"];
type Invite = SplitGroupOut["invites"][number];

/**
 * Invites waiting (owner, November 11, 2026): who each went to (from this device's record; the
 * server keeps only a hash), when it runs out, Remind once a day and Cancel. An invite this
 * device has no address for offers Who's this? any day (the server checks the address against
 * its hash) and asks for it before reminding; either way it is remembered.
 */
export function InvitesWaiting({
  group,
  onChanged,
}: {
  group: SplitGroupOut;
  onChanged: () => Promise<void> | void;
}) {
  const { db } = useDb();
  const emails = useInvitedEmails();
  const [note, setNote] = useState<string | null>(null);
  // "who": Who's this? (any day; checked, then remembered). "remind": the address for a reminder.
  const [asking, setAsking] = useState<{ invite: Invite; why: "who" | "remind" } | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!group.is_organizer || group.invites.length === 0) return null;

  async function remind(invite: Invite, email: string): Promise<boolean> {
    setBusy(true);
    const r = await remindInvite(group.id, invite.id, email);
    setBusy(false);
    if (!r.ok) {
      const text = splitErrorText(r.code);
      if (asking) setError(text);
      else setNote(text);
      return false;
    }
    await rememberInvite(db, invite.id, email);
    setNote(`Reminder sent to ${email}. The new link works for the same 7 days.`);
    await onChanged();
    return true;
  }

  async function name(invite: Invite, email: string): Promise<boolean> {
    setBusy(true);
    const r = await checkInvite(group.id, invite.id, email);
    setBusy(false);
    if (!r.ok) {
      setError(splitErrorText(r.code));
      return false;
    }
    await rememberInvite(db, invite.id, email);
    return true;
  }

  function ask(invite: Invite, why: "who" | "remind") {
    setNote(null);
    setTyped("");
    setError(null);
    setAsking({ invite, why });
  }

  return (
    <Card as="section" aria-labelledby="split-invites-h">
      <h2 className="sk-card__title" id="split-invites-h">
        Invites waiting
      </h2>
      {group.invites.map((i) => {
        const email = emails.get(i.id);
        const sent = formatDay(dayOf(i.created_at));
        const who = email ?? `the invite sent ${sent}`;
        return (
          <div className="split-pay" key={i.id}>
            <span className="split-pay__text">
              <strong>{email ?? `Invited ${sent}`}</strong>
              {email ? null : (
                <>
                  {" "}
                  <button type="button" className="auth__link" onClick={() => ask(i, "who")}>
                    Who's this?
                  </button>
                </>
              )}
              <br />
              <span className="split-invite__when">
                {email ? `Sent ${sent} · ` : ""}Expires {formatDay(dayOf(i.expires_at))}
                {i.reminded_at ? ` · Reminded ${formatDay(dayOf(i.reminded_at))}` : ""}
              </span>
            </span>
            {/* Remind and Cancel side by side, one width (owner, November 11, 2026); the day's
                wait is the button's own words. */}
            <span className="split-invite__actions">
              {canRemindNow(i) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`Remind ${who}`}
                  onClick={() => {
                    setNote(null);
                    if (email) void remind(i, email);
                    else ask(i, "remind");
                  }}
                >
                  Remind
                </Button>
              ) : (
                <Button size="sm" variant="secondary" disabled>
                  Remind tomorrow
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                aria-label={`Cancel ${who}`}
                onClick={async () => {
                  const r = await cancelInvite(group.id, i.id);
                  setNote(r.ok ? "Invite cancelled." : splitErrorText(r.code ?? ""));
                  await onChanged();
                }}
              >
                Cancel
              </Button>
            </span>
          </div>
        );
      })}
      {note ? <p role="status">{note}</p> : null}
      <Sheet
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking?.why === "who" ? "Who did you invite?" : "Remind them"}
      >
        <p>
          {asking?.why === "who"
            ? "This device doesn't have the address. Type the email you invited and Qash checks it's the one."
            : "This device doesn't have the address. Type the email you invited."}
        </p>
        <label className="auth__field">
          <span className="auth__label">Their email</span>
          <input
            className="auth__input"
            type="email"
            autoComplete="off"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          block
          disabled={busy}
          onClick={async () => {
            if (!typed.includes("@")) return setError("Enter their email.");
            if (!asking) return;
            const done =
              asking.why === "who"
                ? await name(asking.invite, typed.trim())
                : await remind(asking.invite, typed.trim());
            if (done) setAsking(null);
          }}
        >
          {asking?.why === "who" ? "Save" : "Send reminder"}
        </Button>
      </Sheet>
    </Card>
  );
}
