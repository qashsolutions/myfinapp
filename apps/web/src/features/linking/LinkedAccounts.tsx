import "../auth/auth.css";

import { Button, Card, List, ListRow, Sheet } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { shortDate, shortTime } from "../../lib/dates.ts";
import { formatDate } from "../../lib/format.ts";
import { PlanLimit } from "../billing/PlanLimit.tsx";
import { useStepUp } from "../security/StepUpPrompt.tsx";
import { disconnect, linkErrorText, startLink, startRelink, useLinking } from "./linking.ts";
import { describeReport, syncAll } from "./sync.ts";

/**
 * Me → Linked banks & cards (Phase 3, chunk 3.2; docs/spec.md "Bank linking", no mockup):
 * what linking reads and never reads, the connections with one-tap Disconnect, and Connect,
 * which runs the passkey check and then sends the browser to the provider's own page.
 */
export function LinkedAccounts() {
  const { db } = useDb();
  const stepUp = useStepUp();
  const { status, error, refresh } = useLinking();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<{ id: string; name: string } | null>(null);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [db]) ?? [];

  const connections = status?.connections ?? [];
  const cap = status?.max_connections;
  const full = cap !== null && cap !== undefined && connections.length >= cap;

  async function connect() {
    setNote(null);
    if (!(await stepUp.confirm("Linking a bank or card"))) return;
    setBusy(true);
    const failure = await startLink();
    setBusy(false);
    if (failure) setNote(linkErrorText(failure.code));
  }

  async function syncNow() {
    setNote(null);
    setBusy(true);
    const { report, failures } = await syncAll(db, connections);
    setBusy(false);
    await refresh();
    if (failures.length) {
      setNote(linkErrorText(failures[0]?.code ?? ""));
      return;
    }
    const changed = describeReport(report);
    setNote(changed ? `${changed}.` : "Up to date.");
  }

  async function signInAgain(id: string) {
    setNote(null);
    setBusy(true);
    const failure = await startRelink(id);
    setBusy(false);
    if (failure) setNote(linkErrorText(failure.code));
  }

  async function confirmDisconnect() {
    if (!leaving) return;
    setBusy(true);
    const failure = await disconnect(db, leaving.id);
    setBusy(false);
    if (failure) {
      setNote(linkErrorText(failure.code));
      return;
    }
    setNote(`${leaving.name} is disconnected. Its accounts and entries stay on this device.`);
    setLeaving(null);
    await refresh();
  }

  return (
    <>
      <ScreenHeader title="Linked banks & cards" back="/me/data" actions={null} />
      <Card as="section" aria-labelledby="link-what-h">
        <h2 className="sk-card__title" id="link-what-h">
          Read-only, and only if you want it
        </h2>
        <ul className="terms__list">
          <li>
            Reads your transactions and, for credit cards, the statement balance, due date, minimum,
            credit limit and APR.
          </li>
          <li>It can never move money.</li>
          <li>We never see your bank password or account numbers.</li>
          <li>
            You sign in on your bank's own page through our provider, Plaid, and pick each account.
          </li>
          <li>Transactions pass through our server to this device and aren't kept there.</li>
          <li>Uploading statements still works for every account, linked or not.</li>
        </ul>
      </Card>

      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {linkErrorText(error.code)}
        </p>
      ) : null}

      {status && !status.available ? (
        <Card as="div">
          <p>Linking isn't switched on yet. Statement upload works for every account meanwhile.</p>
        </Card>
      ) : null}
      {status?.available && cap === 0 ? (
        <PlanLimit>Linking banks and cards comes with Connected, up to 3 connections.</PlanLimit>
      ) : null}

      {connections.length > 0 ? (
        <section aria-labelledby="link-list-h">
          <h2 className="section-title" id="link-list-h">
            Connected
          </h2>
          <List card>
            {connections.map((c) => {
              const here = accounts.filter((a) => a.linked?.connection_id === c.id);
              const names = here
                .map((a) => (a.last4 ? `${a.label} ••${a.last4}` : a.label))
                .join(", ");
              return (
                <ListRow
                  key={c.id}
                  label={c.institution_name}
                  sublabel={`${connectionState(c)}${names ? ` · ${names}` : ""}`}
                  value={
                    <span className="link-actions">
                      {c.status === "login_required" ? (
                        <Button size="sm" onClick={() => signInAgain(c.id)} disabled={busy}>
                          Sign in again
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setLeaving({ id: c.id, name: c.institution_name })}
                      >
                        Disconnect
                      </Button>
                    </span>
                  }
                />
              );
            })}
          </List>
          <Button block variant="secondary" onClick={syncNow} disabled={busy}>
            {busy ? "Checking…" : "Check for new transactions"}
          </Button>
        </section>
      ) : null}

      {status?.available && cap !== 0 ? (
        <>
          <Button block onClick={connect} disabled={busy || full}>
            {busy ? "Opening…" : "Connect a bank or card"}
          </Button>
          <p className="auth__fineprint">
            {full
              ? `Your plan includes ${cap} connections. Disconnect one to add another.`
              : "Linked accounts update when you open the app, and again every 15 minutes while it's open."}
          </p>
        </>
      ) : null}

      <Sheet
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        title={`Disconnect ${leaving?.name ?? ""}?`}
      >
        <p>
          We'll revoke access at the bank's provider and delete our copy of the connection. The
          accounts and every entry stay on this device, and you can still upload statements.
        </p>
        <Button block onClick={confirmDisconnect} disabled={busy}>
          {busy ? "Disconnecting…" : "Disconnect"}
        </Button>
        <Button block variant="secondary" onClick={() => setLeaving(null)}>
          Keep it
        </Button>
      </Sheet>
    </>
  );
}

function connectionState(c: {
  status: string;
  created_at: string;
  last_synced_at?: string | null;
}): string {
  if (c.status === "login_required") return "Your bank needs you to sign in again";
  if (c.status === "revoked")
    return "Access was withdrawn at the bank. Disconnect, then link again";
  if (c.last_synced_at)
    return `Updated ${shortDate(c.last_synced_at)}, ${shortTime(c.last_synced_at)}`;
  return `Linked ${formatDate(c.created_at.slice(0, 10))}`;
}
