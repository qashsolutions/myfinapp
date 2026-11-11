import { Button, Sheet } from "@stackd/ui";
import { useEffect, useRef, useState } from "react";
import { toBase64url } from "../../data/backup/crypto.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { dayOf, formatDay } from "../../lib/format.ts";
import { type QrPath, qrPath } from "../auth/linkQr.ts";
import { canRemindNow, rememberInvite, sameEmail, useInvitedEmails } from "./invited.ts";
import { groupKey, inPersonLink } from "./splitSync.ts";
import { remindInvite, type SplitGroupOut, sendInvite, splitErrorText } from "./useSplits.ts";

/**
 * Invite by email (spec "Invites"): bound to that inbox, single use, 7 days. With double-check on
 * the email is typed twice and Send stays off until they match. "In person?" shows the same
 * invite as a QR code whose fragment carries the group's key, so their device opens it at once.
 */
export function InviteSheet({
  group,
  doubleCheck,
  invitesToday,
  open,
  onClose,
  onSent,
}: {
  group: SplitGroupOut;
  doubleCheck: boolean;
  /** Email invites sent today against the plan's day, for "4 invites left today". */
  invitesToday: { added: number; limit: number };
  open: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const { db } = useDb();
  const [email, setEmail] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [qr, setQr] = useState<QrPath | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reminded, setReminded] = useState<string | null>(null);
  const emails = useInvitedEmails();
  const emailBox = useRef<HTMLInputElement>(null);
  const againBox = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setEmail("");
      setAgain("");
      setError(null);
      setSentTo(null);
      setToken(null);
      setQr(null);
      setShowQr(false);
      setReminded(null);
    }
  }, [open]);

  useEffect(() => {
    if (!showQr || !token) return;
    let alive = true;
    void (async () => {
      const key = await groupKey(db, group.id);
      if (!key) return;
      const path = await qrPath(inPersonLink(token, toBase64url(key)));
      if (alive) setQr(path);
    })();
    return () => {
      alive = false;
    };
  }, [showQr, token, db, group.id]);

  const clean = email.trim();
  const matches = !doubleCheck || again.trim().toLowerCase() === clean.toLowerCase();
  const people = group.members.length + group.invites.length;
  const full = people >= group.people_max;
  const left = Math.max(0, invitesToday.limit - invitesToday.added);
  // Already invited (November 11, 2026): the same inbox never gets a second invite while one
  // waits; the organizer reminds instead.
  const waiting = clean.includes("@")
    ? group.invites.find((i) => {
        const to = emails.get(i.id);
        return to !== undefined && sameEmail(to, clean);
      })
    : undefined;

  async function remind() {
    if (!waiting) return;
    setBusy(true);
    const r = await remindInvite(group.id, waiting.id, clean);
    setBusy(false);
    if (!r.ok) return setError(splitErrorText(r.code));
    setError(null);
    setReminded(clean);
    onSent();
  }

  async function send() {
    // Never a dead button (November 11, 2026): say what's missing and go there.
    if (!clean.includes("@")) {
      setError("Enter their email.");
      emailBox.current?.focus();
      return;
    }
    if (!matches) {
      setError("The two emails don't match.");
      againBox.current?.focus();
      return;
    }
    setBusy(true);
    const r = await sendInvite(group.id, clean, doubleCheck ? again.trim() : null);
    setBusy(false);
    if (!r.ok) {
      setError(splitErrorText(r.code));
      return;
    }
    await rememberInvite(db, r.id, clean);
    setError(null);
    setSentTo(clean);
    setToken(r.token);
    onSent();
  }

  return (
    <Sheet open={open} onClose={onClose} title="Invite by email">
      {reminded ? (
        <>
          <p role="status">Reminder sent to {reminded}. The new link works for the same 7 days.</p>
          <Button block onClick={onClose}>
            Done
          </Button>
        </>
      ) : sentTo ? (
        <>
          <p role="status">Invite sent to {sentTo}. It works once, for that inbox, for 7 days.</p>
          {showQr ? (
            qr ? (
              <svg
                className="split-qr"
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                role="img"
                aria-label="QR code to join this group"
              >
                <rect width={qr.size} height={qr.size} fill="#fff" />
                <path d={qr.d} fill="#000" />
              </svg>
            ) : (
              <p className="sr-only" role="status">
                Making the code
              </p>
            )
          ) : (
            <Button block variant="secondary" onClick={() => setShowQr(true)}>
              In person? Show a QR code
            </Button>
          )}
          {showQr ? (
            <p className="auth__hint">
              They scan it with their camera, then sign in with the code sent to {sentTo}.
            </p>
          ) : null}
          <Button block variant="ghost" onClick={onClose}>
            Done
          </Button>
        </>
      ) : (
        <>
          {doubleCheck ? (
            <p className="auth__hint" role="status">
              Double-check is on: type the email twice.
            </p>
          ) : null}
          <label className="auth__field">
            <span className="auth__label">Their email</span>
            <input
              className="auth__input"
              type="email"
              autoComplete="off"
              ref={emailBox}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
            />
          </label>
          {doubleCheck ? (
            <label className="auth__field">
              <span className="auth__label">Their email again</span>
              <input
                className="auth__input"
                type="email"
                autoComplete="off"
                ref={againBox}
                value={again}
                onChange={(e) => {
                  setAgain(e.target.value);
                  setError(null);
                }}
              />
            </label>
          ) : null}
          <p className="auth__hint">
            They get an email from Qash with your name and a masked email. Nobody joins without
            saying yes.
          </p>
          <p className="split-invite__limits" role="status">
            {people} of {group.people_max} people on your plan · {left}{" "}
            {left === 1 ? "invite" : "invites"} left today
          </p>
          {waiting ? (
            <div className="split-pay" role="status">
              <span className="split-pay__text">
                Already invited {formatDay(dayOf(waiting.created_at))}
                {waiting.reminded_at ? `, reminded ${formatDay(dayOf(waiting.reminded_at))}` : ""}.{" "}
                {canRemindNow(waiting)
                  ? "Send them a reminder instead."
                  : "You can remind them again tomorrow."}
              </span>
            </div>
          ) : null}
          {full ? (
            <p className="auth__hint" role="status">
              This group is full for your plan ({group.people_max} people).
            </p>
          ) : null}
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
          {waiting ? (
            canRemindNow(waiting) ? (
              <Button block onClick={remind} disabled={busy}>
                Send a reminder
              </Button>
            ) : null
          ) : (
            <Button block onClick={send} disabled={busy || full}>
              Send invite
            </Button>
          )}
        </>
      )}
    </Sheet>
  );
}
