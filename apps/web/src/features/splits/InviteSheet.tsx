import { Button, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { toBase64url } from "../../data/backup/crypto.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { type QrPath, qrPath } from "../auth/linkQr.ts";
import { groupKey, inPersonLink } from "./splitSync.ts";
import { type SplitGroupOut, sendInvite, splitErrorText } from "./useSplits.ts";

/**
 * Invite by email (spec "Invites"): bound to that inbox, single use, 7 days. With double-check on
 * the email is typed twice and Send stays off until they match. "In person?" shows the same
 * invite as a QR code whose fragment carries the group's key, so their device opens it at once.
 */
export function InviteSheet({
  group,
  doubleCheck,
  open,
  onClose,
  onSent,
}: {
  group: SplitGroupOut;
  doubleCheck: boolean;
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

  useEffect(() => {
    if (!open) {
      setEmail("");
      setAgain("");
      setError(null);
      setSentTo(null);
      setToken(null);
      setQr(null);
      setShowQr(false);
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
  const full = group.members.length + group.invites.length >= group.people_max;

  async function send() {
    setBusy(true);
    const r = await sendInvite(group.id, clean, doubleCheck ? again.trim() : null);
    setBusy(false);
    if (!r.ok) {
      setError(splitErrorText(r.code));
      return;
    }
    setError(null);
    setSentTo(clean);
    setToken(r.token);
    onSent();
  }

  return (
    <Sheet open={open} onClose={onClose} title="Invite by email">
      {sentTo ? (
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          {doubleCheck ? (
            <label className="auth__field">
              <span className="auth__label">Their email again</span>
              <input
                className="auth__input"
                type="email"
                autoComplete="off"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </label>
          ) : null}
          <p className="auth__hint">
            They get an email from Qash with your name and a masked email. Nobody joins without
            saying yes.
          </p>
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
          <Button block onClick={send} disabled={busy || full || !clean.includes("@") || !matches}>
            Send invite
          </Button>
        </>
      )}
    </Sheet>
  );
}
