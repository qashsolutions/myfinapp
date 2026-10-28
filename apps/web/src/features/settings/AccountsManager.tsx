import { releasePartners } from "../entries/transfers.ts";
import "../auth/auth.css";
import "../groups/groups.css";
import "../entries/entries.css";

import { Button, buttonClass, Card, Chip, List, ListRow, Sheet } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useId, useState } from "react";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { type Account, type AccountType, newId } from "../../data/db.ts";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";

const TYPE_LABELS: Record<AccountType, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Card",
  cash: "Cash",
};

/**
 * Accounts & imports (mockup F6Accounts): every account with its balance, last import and
 * format; set a balance; add or remove an account (category rules and saved names are on Categories since October 23, 2026). Everything here lives
 * on this device; removing an account deletes its imported transactions after you confirm.
 */
export function AccountsManager() {
  const { db } = useDb();
  const ids = useId();
  const today = todayIso();
  const accounts = useLiveQuery(() => db.accounts.orderBy("created_at").toArray(), [db]);
  const anchors = useLiveQuery(() => db.balance_anchors.toArray(), [db]);
  const imports = useLiveQuery(() => db.statement_imports.toArray(), [db]);
  const mappings = useLiveQuery(() => db.csv_mappings.toArray(), [db]);
  const categories = useLiveQuery(() => db.categories.toArray(), [db]);
  const [editing, setEditing] = useState<Account | "new" | null>(null);
  const [balanceFor, setBalanceFor] = useState<Account | null>(null);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [last4, setLast4] = useState("");
  const [balanceText, setBalanceText] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const categoryName = new Map((categories ?? []).map((c) => [c.id, c.name]));

  function openEditor(target: Account | "new") {
    setEditing(target);
    setLabel(target === "new" ? "" : target.label);
    setType(target === "new" ? "checking" : target.type);
    setLast4(target === "new" ? "" : (target.last4 ?? ""));
    setError(null);
  }

  async function saveAccount() {
    if (!label.trim()) {
      setError("Give the account a name.");
      return;
    }
    const digits = last4.replace(/[^0-9]/g, "").slice(-4) || null;
    if (editing === "new") {
      await db.accounts.add({
        id: newId(),
        label: label.trim(),
        type,
        last4: digits,
        institution: null,
        currency: "USD",
        created_at: new Date().toISOString(),
      });
    } else if (editing) {
      await db.accounts.update(editing.id, { label: label.trim(), type, last4: digits });
    }
    setEditing(null);
  }

  async function saveBalance() {
    if (!balanceFor) return;
    try {
      const cents = await parseAmount(balanceText);
      await db.balance_anchors.add({
        id: newId(),
        account_id: balanceFor.id,
        as_of: today,
        balance_cents: cents,
        source: "user",
        created_at: new Date().toISOString(),
      });
      setBalanceFor(null);
      setBalanceText("");
      setError(null);
    } catch {
      setError("Enter a balance like 2,100.00.");
    }
  }

  /** Removing an account removes what came with it: entries, imports, anchors, mapping, kept files. */
  async function removeAccount(account: Account) {
    await db.transaction(
      "rw",
      [
        db.accounts,
        db.entries,
        db.statement_imports,
        db.balance_anchors,
        db.csv_mappings,
        db.files,
        db.tombstones,
      ],
      async () => {
        const imports = await db.statement_imports.where("account_id").equals(account.id).toArray();
        const fileIds = imports.map((i) => i.file_key).filter((k): k is string => k !== null);
        const entryIds = (await db.entries
          .where("account_id")
          .equals(account.id)
          .primaryKeys()) as string[];
        const anchorIds = (await db.balance_anchors
          .where("account_id")
          .equals(account.id)
          .primaryKeys()) as string[];
        await db.files.bulkDelete(fileIds);
        await db.entries.where("account_id").equals(account.id).delete();
        await db.statement_imports.where("account_id").equals(account.id).delete();
        await db.balance_anchors.where("account_id").equals(account.id).delete();
        await db.csv_mappings.delete(account.id);
        await db.accounts.delete(account.id);
        await recordDeletion(db, "entries", entryIds);
        await releasePartners(db, entryIds); // a transfer's other side, in another account
        await recordDeletion(
          db,
          "statement_imports",
          imports.map((i) => i.id),
        );
        await recordDeletion(db, "balance_anchors", anchorIds);
        await recordDeletion(db, "csv_mappings", [account.id]);
        await recordDeletion(db, "accounts", [account.id]);
      },
    );
    setConfirmRemove(null);
    setEditing(null);
  }

  return (
    <>
      <ScreenHeader
        title="Accounts & imports"
        back="/me/data"
        actions={
          <Link to="/import" className={buttonClass({ size: "sm", variant: "secondary" })}>
            Import
          </Link>
        }
      />
      {accounts?.map((a) => {
        const latest = [...(anchors ?? [])]
          .filter((x) => x.account_id === a.id)
          .sort(
            (x, y) => compareText(y.as_of, x.as_of) || compareText(y.created_at, x.created_at),
          )[0];
        const lastImport = [...(imports ?? [])]
          .filter((i) => i.account_id === a.id)
          .sort((x, y) => compareText(y.created_at, x.created_at))[0];
        const mapping = mappings?.find((m) => m.account_id === a.id);
        return (
          <Card as="section" key={a.id} aria-label={a.label}>
            <div className="goal-card__top">
              <span className="goal-card__title">{a.label}</span>
              <Chip tone="accent">
                {TYPE_LABELS[a.type]}
                {a.last4 ? ` ••${a.last4}` : ""}
              </Chip>
            </div>
            <dl className="forecast__how" style={{ margin: 0 }}>
              <div className="hero-split">
                <dt className="group-row__meta">Balance</dt>
                <dd>
                  {latest
                    ? `${formatCents(latest.balance_cents)} · ${latest.source === "statement" ? `from ${formatDay(latest.as_of)} statement` : "you entered"}`
                    : "Not set"}
                </dd>
              </div>
              <div className="hero-split">
                <dt className="group-row__meta">Last import</dt>
                <dd>
                  {lastImport
                    ? `${formatDay(lastImport.created_at.slice(0, 10))} · ${lastImport.rows_added} added${lastImport.rows_skipped ? `, ${lastImport.rows_skipped} skipped` : ""}`
                    : "Never imported"}
                </dd>
              </div>
              <div className="hero-split">
                <dt className="group-row__meta">Format</dt>
                <dd>
                  {lastImport
                    ? `${lastImport.format.toUpperCase()}${mapping ? " · mapping saved" : ""}`
                    : latest
                      ? "Manual balance"
                      : "—"}
                </dd>
              </div>
            </dl>
            <div className="suggestion__actions">
              <Link to="/import" className={buttonClass({ variant: "secondary", block: true })}>
                Import new file
              </Link>
              <Button
                variant="secondary"
                block
                onClick={() => {
                  setBalanceFor(a);
                  setBalanceText("");
                  setError(null);
                }}
              >
                Set balance
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => openEditor(a)}>
              Edit or remove
            </Button>
          </Card>
        );
      })}
      <Button block variant="secondary" onClick={() => openEditor("new")}>
        + Add an account
      </Button>
      <p className="auth__fineprint">
        Everything here lives on this device. Removing an account deletes its imported transactions
        after you confirm.
      </p>
      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add an account" : "Edit account"}
      >
        <label className="auth__field">
          <span className="auth__label">Name</span>
          <input
            className="auth__input"
            placeholder="e.g. Everyday checking"
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="auth__field">
          <span className="auth__label">Type</span>
          <select
            className="auth__input"
            value={type}
            onChange={(e) => setType(e.target.value as AccountType)}
          >
            {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="auth__field">
          <span className="auth__label">Last 4 digits (optional)</span>
          <input
            id={`${ids}-last4`}
            className="auth__input"
            inputMode="numeric"
            maxLength={4}
            value={last4}
            onChange={(e) => setLast4(e.target.value)}
          />
        </label>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={saveAccount}>
          {editing === "new" ? "Add" : "Save"}
        </Button>
        {editing && editing !== "new" ? (
          <Button
            block
            variant="ghost"
            onClick={() =>
              confirmRemove === editing.id
                ? void removeAccount(editing)
                : setConfirmRemove(editing.id)
            }
          >
            <span style={{ color: "var(--c-danger)" }}>
              {confirmRemove === editing.id
                ? "Really remove, with its transactions"
                : "Remove account"}
            </span>
          </Button>
        ) : null}
      </Sheet>
      <Sheet
        open={balanceFor !== null}
        onClose={() => setBalanceFor(null)}
        title={`Balance in ${balanceFor?.label ?? ""}`}
      >
        <p className="auth__hint">
          Today's balance. Entries dated after today adjust the forecast from it.
        </p>
        <label className="auth__field">
          <span className="auth__label">Balance</span>
          <input
            className="auth__input"
            inputMode="decimal"
            placeholder="2,100.00"
            value={balanceText}
            onChange={(e) => setBalanceText(e.target.value)}
          />
        </label>
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button block onClick={saveBalance}>
          Save balance
        </Button>
      </Sheet>
    </>
  );
}
