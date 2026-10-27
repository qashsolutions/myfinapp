import { Button, List } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { Account, AccountType } from "../../data/db.ts";
import { formatDay } from "../../lib/format.ts";
import { useEntitlements } from "../billing/entitlements.ts";
import { PlanLimit } from "../billing/PlanLimit.tsx";
import { accountLabel } from "../entries/useEntries.ts";
import { createAccount } from "./importFlow.ts";

const TYPES: Array<[AccountType, string]> = [
  ["checking", "Checking"],
  ["savings", "Savings"],
  ["credit_card", "Credit card"],
  ["cash", "Cash"],
];

export interface AccountSuggestion {
  last4: string;
  type: AccountType | null;
  institution: string | null;
}

const TYPE_NAME: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Card",
  cash: "Cash",
};

/**
 * "Which account is this?" with the last import per account and an inline + New account form.
 * When the statement names its account (October 19, 2026): an account with the same last four
 * is picked for the user, and otherwise a ready-made "New account: <bank> ••1234" is one tap.
 */
export function AccountPicker({
  value,
  onChange,
  suggest = null,
}: {
  value: string | null;
  onChange: (a: Account) => void;
  suggest?: AccountSuggestion | null;
}) {
  const { db } = useDb();
  const ids = useId();
  const accounts = useLiveQuery(() => db.accounts.orderBy("created_at").toArray(), [db]);
  const lastImports = useLiveQuery(async () => {
    const imports = await db.statement_imports.orderBy("created_at").reverse().toArray();
    const map = new Map<string, string>();
    for (const i of imports) if (!map.has(i.account_id)) map.set(i.account_id, i.created_at);
    return map;
  }, [db]);
  const { entitlements } = useEntitlements();
  const accountsMax = entitlements.statement_accounts_max;
  const importedCount = lastImports?.size ?? 0;
  const capped = accountsMax !== null && importedCount >= accountsMax;
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [last4, setLast4] = useState("");

  const sameLast4 = suggest ? (accounts ?? []).find((a) => a.last4 === suggest.last4) : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: pick once per suggested account
  useEffect(() => {
    if (sameLast4 && value === null) onChange(sameLast4);
  }, [sameLast4?.id]);
  const suggestedName = suggest
    ? `${suggest.institution ?? TYPE_NAME[suggest.type ?? "checking"]} ••${suggest.last4}`
    : "";

  async function addSuggested() {
    if (!suggest) return;
    const account = await createAccount(
      db,
      suggest.institution
        ? `${suggest.institution} ${TYPE_NAME[suggest.type ?? "checking"] ?? ""}`.trim()
        : (TYPE_NAME[suggest.type ?? "checking"] ?? "Account"),
      suggest.type ?? "checking",
      suggest.last4,
    );
    if (suggest.institution)
      await db.accounts.update(account.id, { institution: suggest.institution });
    onChange(account);
  }

  async function add() {
    if (!label.trim()) return;
    const account = await createAccount(
      db,
      label,
      type,
      last4.replace(/\D/g, "").slice(-4) || null,
    );
    setAdding(false);
    setLabel("");
    setLast4("");
    onChange(account);
  }

  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
      <legend className="section-title">Which account is this?</legend>
      <List card>
        {(accounts ?? []).map((a) => {
          const last = lastImports?.get(a.id);
          return (
            <li className="sk-list__item" key={a.id}>
              <label className="radio-row">
                <input
                  type="radio"
                  name={`${ids}-account`}
                  value={a.id}
                  checked={value === a.id}
                  disabled={capped && !lastImports?.has(a.id)}
                  onChange={() => onChange(a)}
                />
                <span className="radio-row__dot" aria-hidden="true" />
                <span className="sk-row__text">
                  <span className="sk-row__label">{a.label}</span>
                  <span className="sk-row__sublabel">
                    {accountLabel({
                      ...a,
                      label: TYPES.find(([t]) => t === a.type)?.[1] ?? a.type,
                    })}{" "}
                    · {last ? `last import ${formatDay(last.slice(0, 10))}` : "never imported"}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
        {suggest && !sameLast4 && !capped ? (
          <li className="sk-list__item">
            <Button block onClick={addSuggested}>
              + New account: {suggestedName}
              {suggest.type ? ` · ${TYPE_NAME[suggest.type]}` : ""}
            </Button>
          </li>
        ) : null}
        <li className="sk-list__item">
          {capped ? (
            <PlanLimit>
              Your plan reads statements for {accountsMax}{" "}
              {accountsMax === 1 ? "account" : "accounts"}, and you're using {importedCount}. Choose
              a bigger plan to import into more. What's here stays.
            </PlanLimit>
          ) : adding ? (
            <div className="auth__field" style={{ padding: "8px 0" }}>
              <label className="auth__label" htmlFor={`${ids}-label`}>
                Account name
              </label>
              <input
                id={`${ids}-label`}
                className="auth__input"
                placeholder="e.g. Everyday checking"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <label className="auth__label" htmlFor={`${ids}-type`}>
                Type
              </label>
              <select
                id={`${ids}-type`}
                className="auth__input"
                value={type}
                onChange={(e) => setType(e.target.value as AccountType)}
              >
                {TYPES.map(([t, name]) => (
                  <option key={t} value={t}>
                    {name}
                  </option>
                ))}
              </select>
              <label className="auth__label" htmlFor={`${ids}-last4`}>
                Last 4 digits (optional)
              </label>
              <input
                id={`${ids}-last4`}
                className="auth__input"
                inputMode="numeric"
                maxLength={4}
                placeholder="4821"
                value={last4}
                onChange={(e) => setLast4(e.target.value)}
              />
              <div className="transfer-choice">
                <Button variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button onClick={add} disabled={!label.trim()}>
                  Add account
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setAdding(true)}>
              + New account
            </Button>
          )}
        </li>
      </List>
    </fieldset>
  );
}
