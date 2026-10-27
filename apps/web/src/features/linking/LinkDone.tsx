import "../auth/auth.css";

import { Button, Card, List, ListRow } from "@stackd/ui";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { type Account, ignoreClosed } from "../../data/db.ts";
import { APP_NAME } from "../../lib/brand.ts";
import {
  attachAccounts,
  finishLink,
  isFailure,
  type LinkedAccount,
  type LinkedConnection,
  linkErrorText,
} from "./linking.ts";
import { describeReport, syncAll } from "./sync.ts";

type Outcome =
  | { kind: "working" }
  | { kind: "cancelled" }
  | { kind: "already"; names: string[] }
  | { kind: "error"; text: string }
  | {
      kind: "linked";
      connections: LinkedConnection[];
      used: Account[];
      skipped: LinkedAccount[];
      already: string[]; // banks in this trip that were linked before, so not linked again
      pulled: string | null; // null while the first sync runs
    };

const TYPE_NAMES: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
};

function joinNames(names: string[]): string {
  return names.join(" and ");
}

/** /me/linking/done: where the provider's page sends the browser back (chunk 3.2). */
export function LinkDone() {
  const { db } = useDb();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sessionId = params.get("session") ?? "";
  const [outcome, setOutcome] = useState<Outcome>({ kind: "working" });
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    if (!sessionId) {
      setOutcome({ kind: "error", text: linkErrorText("not_found") });
      return;
    }
    void (async () => {
      const result = await finishLink(sessionId);
      if (isFailure(result)) {
        setOutcome({ kind: "error", text: linkErrorText(result.code) });
        return;
      }
      const already = result.already_linked ?? [];
      if (result.status === "already_linked") {
        setOutcome({ kind: "already", names: already });
        return;
      }
      if (result.status !== "linked") {
        setOutcome({ kind: "cancelled" });
        return;
      }
      const { used, skipped } = await attachAccounts(db, result.connections);
      setOutcome({
        kind: "linked",
        connections: result.connections,
        used,
        skipped,
        already,
        pulled: null,
      });
      // The first pull: history arrives with the link, so the numbers fill in right away.
      const { report } = await syncAll(db, result.connections);
      setOutcome({
        kind: "linked",
        connections: result.connections,
        used,
        skipped,
        already,
        pulled: describeReport(report) || "nothing yet",
      });
      // Signing out (or leaving) mid-pull closes the database; the next open pulls again.
    })().catch(ignoreClosed);
  }, [db, sessionId]);

  return (
    <>
      <ScreenHeader title="Linking" back="/me/linking" actions={null} />
      {outcome.kind === "working" ? (
        <p role="status">Finishing up with your bank…</p>
      ) : outcome.kind === "cancelled" ? (
        <Card as="div" role="status">
          <p>Nothing was linked. You can try again any time, or keep uploading statements.</p>
        </Card>
      ) : outcome.kind === "already" ? (
        <Card as="div" role="status">
          <p>
            {joinNames(outcome.names)} {outcome.names.length === 1 ? "is" : "are"} already linked,
            so nothing new was added. If it stopped updating, tap Sign in again on it.
          </p>
        </Card>
      ) : outcome.kind === "error" ? (
        <p className="auth__error" role="alert">
          {outcome.text}
        </p>
      ) : (
        <>
          <p role="status">
            {outcome.connections.map((c) => c.institution_name).join(" and ")}{" "}
            {outcome.connections.length === 1 ? "is" : "are"} linked.
          </p>
          <p className="auth__hint" role="status">
            {outcome.pulled === null
              ? "Bringing in your transactions…"
              : `Transactions: ${outcome.pulled}. Money in & out and your next 30 days now include them.`}
          </p>
          <section aria-labelledby="linked-h">
            <h2 className="section-title" id="linked-h">
              Accounts on this device
            </h2>
            <List card>
              {outcome.used.map((a) => (
                <ListRow
                  key={a.id}
                  label={a.last4 ? `${a.label} ••${a.last4}` : a.label}
                  sublabel={TYPE_NAMES[a.type] ?? a.type}
                />
              ))}
            </List>
          </section>
          {outcome.already.length > 0 ? (
            <p className="auth__hint">
              {joinNames(outcome.already)} {outcome.already.length === 1 ? "was" : "were"} linked
              already, so {outcome.already.length === 1 ? "it was" : "they were"} not added again.
            </p>
          ) : null}
          {outcome.skipped.length > 0 ? (
            <p className="auth__hint">
              Not used: {outcome.skipped.map((a) => a.name).join(", ")}. {APP_NAME} reads checking,
              savings and credit cards only.
            </p>
          ) : null}
        </>
      )}
      {outcome.kind !== "working" ? (
        <Button block onClick={() => navigate("/me/linking")}>
          Done
        </Button>
      ) : null}
    </>
  );
}
