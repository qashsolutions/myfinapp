import { Button, Card, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { buildSnapshot, mergeSnapshot } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { closeDb, deleteDb, openDb, type StackdDb } from "../../data/db.ts";
import { collectExport, downloadBytes, zipStore } from "../../data/export.ts";
import { engine } from "../../engine/bridge.ts";
import { formatDate, todayIso } from "../../lib/format.ts";
import { currentHashFor, forgetKept, keptAccount } from "../../lib/keptAccount.ts";
import { useSession } from "../auth/useSession.tsx";

/** Download everything a kept account left on this phone, built here with no server. */
async function downloadKept(db: StackdDb): Promise<boolean> {
  const at = new Date();
  const files = await collectExport(db, null, at.toISOString());
  return downloadBytes(zipStore(files, at), `qash-export-${todayIso()}.zip`);
}

async function eraseKept(userId: string): Promise<void> {
  try {
    closeDb(userId);
    await deleteDb(userId);
  } finally {
    forgetKept();
  }
}

/**
 * /kept: the account closed because its plan ended, and this phone still holds everything
 * (owner, October 20, 2026: kept until the person decides; a friendly note, not a warning).
 */
export function KeptOnPhone() {
  const navigate = useNavigate();
  const kept = keptAccount();
  const [note, setNote] = useState<string | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);
  const [entries, setEntries] = useState<number | null>(null);

  useEffect(() => {
    if (!kept) return;
    const db = openDb(kept.user_id);
    void db.entries
      .count()
      .then(setEntries)
      .catch(() => setEntries(null));
  }, [kept]);

  if (!kept) return <Navigate to="/welcome" replace />;
  const db = openDb(kept.user_id);

  return (
    <main className="auth" id="main">
      <ScreenHeader title="Your data is safe here" actions={null} />
      <Card>
        <p>
          Your Qash account closed on {formatDate(kept.closed_at)}, when your plan wrapped up.
          Everything you added is still on this phone
          {entries ? `, including ${entries} ${entries === 1 ? "entry" : "entries"}` : ""}, and it
          stays here until you decide.
        </p>
      </Card>
      <Button
        block
        onClick={async () => {
          const saved = await downloadKept(db);
          setNote(
            saved
              ? "Downloaded. Keep the file somewhere safe; it holds your money data."
              : "This browser didn't offer a download. Try another browser on this phone.",
          );
        }}
      >
        Download my data
      </Button>
      <Button variant="secondary" block onClick={() => navigate("/welcome")}>
        Start again with Qash
      </Button>
      <p className="auth__hint">
        Sign up again with the same email on this phone, and Qash offers to bring this data in.
      </p>
      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}
      <Button variant="ghost" block onClick={() => setConfirmErase(true)}>
        Erase it from this phone
      </Button>
      <Sheet
        open={confirmErase}
        onClose={() => setConfirmErase(false)}
        title="Erase from this phone?"
      >
        <p className="auth__lead">
          This removes your Qash data from this phone for good. Download it first if you want a
          copy.
        </p>
        <Button
          block
          onClick={async () => {
            await eraseKept(kept.user_id);
            navigate("/welcome", { replace: true });
          }}
        >
          Erase it
        </Button>
        <Button variant="secondary" block onClick={() => setConfirmErase(false)}>
          Keep it
        </Button>
      </Sheet>
    </main>
  );
}

/**
 * Home after signing up again with the same email on the same phone: offer to bring the kept
 * data into the new account (a backup snapshot merged in, on the device). Asked once.
 */
export function BringBackOffer() {
  const session = useSession();
  const { db } = useDb();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  // Read once: bringing the data back forgets the record, and the sheet still says so.
  const [kept] = useState(() => keptAccount());
  const me = session.info?.user?.id ?? null;

  useEffect(() => {
    if (!kept || !me || kept.user_id === me || !kept.email_hash) return;
    // Same person: the email hash recorded while they were signed in matches this account's.
    const mine = currentHashFor(me);
    if (mine && mine === kept.email_hash) setOpen(true);
  }, [kept, me]);

  if (!kept || !open) return null;
  return (
    <Sheet
      open={open}
      onClose={() => setOpen(false)}
      title={state === "done" ? "Welcome back" : "Bring back your data?"}
    >
      {state === "done" ? (
        <>
          <p className="auth__lead">Everything from before is back, right where you left it.</p>
          <Button block onClick={() => setOpen(false)}>
            Done
          </Button>
        </>
      ) : (
        <>
          <p className="auth__lead">
            This phone still has your data from before ({formatDate(kept.closed_at)}). Bring it into
            your new account?
          </p>
          <Button
            block
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              const old = openDb(kept.user_id);
              const snapshot = await buildSnapshot(old, {
                rulesVersion: engine.rulesVersion ?? "unknown",
                deviceId: "kept",
              });
              await mergeSnapshot(db, snapshot);
              await eraseKept(kept.user_id);
              setState("done");
            }}
          >
            {state === "busy" ? "Bringing it back…" : "Yes, bring it back"}
          </Button>
          <Button variant="secondary" block onClick={() => setOpen(false)}>
            Not now
          </Button>
        </>
      )}
    </Sheet>
  );
}
