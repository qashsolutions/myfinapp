import type { components } from "@stackd/api-client";
import { Button, Card, Sheet } from "@stackd/ui";
import { useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import { dayOf, formatDay } from "../../lib/format.ts";
import { canRemindNow, rememberInvite, useInvitedEmails } from "./invited.ts";
import { cancelInvite, remindInvite, splitErrorText } from "./useSplits.ts";

type SplitGroupOut = components["schemas"]["SplitGroupOut"];
type Invite = SplitGroupOut["invites"][number];

/**
 * Invites waiting (owner, November 11, 2026): who each went to (from this device's record; the
 * server keeps only a hash), when it runs out, Remind once a day and Cancel. An invite this
 * device has no address for asks for it before reminding, and remembers it.
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
  const [asking, setAsking] = useState<Invite | null>(null);
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

  return (
    <Card as="section" aria-labelledby="split-invites-h">
      <h2 className="sk-card__title" id="split-invites-h">
        Invites waiting
      </h2>
      {group.invites.map((i) => {
        const email = emails.get(i.id);
        const sent = formatDay(dayOf(i.created_at));
        return (
          <div className="split-pay" key={i.id}>
            <span className="split-pay__text">
              <strong>{email ?? `Invited ${sent}`}</strong>
              <br />
              <span className="split-invite__when">
                {email ? `Sent ${sent} · ` : ""}Expires {formatDay(dayOf(i.expires_at))}
                {i.reminded_at ? ` · Reminded ${formatDay(dayOf(i.reminded_at))}` : ""}
              </span>
            </span>
            <span className="split-pay__actions">
              {canRemindNow(i) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`Remind ${email ?? `the invite sent ${sent}`}`}
                  onClick={() => {
                    setNote(null);
                    if (email) void remind(i, email);
                    else {
                      setTyped("");
                      setError(null);
                      setAsking(i);
                    }
                  }}
                >
                  Remind
                </Button>
              ) : (
                <span className="split-invite__when">Remind tomorrow</span>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Cancel ${email ?? `the invite sent ${sent}`}`}
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
      <Sheet open={asking !== null} onClose={() => setAsking(null)} title="Remind them">
        <p>This device doesn't have the address. Type the email you invited.</p>
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
            if (asking && (await remind(asking, typed.trim()))) setAsking(null);
          }}
        >
          Send reminder
        </Button>
      </Sheet>
    </Card>
  );
}
