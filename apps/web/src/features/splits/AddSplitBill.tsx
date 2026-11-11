import "./splits.css";
import "../auth/auth.css";
import "../groups/groups.css";

import { Button, Card } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { Entry } from "../../data/db.ts";
import {
  parseAmount,
  type SplitMethod,
  type SplitPart,
  type SplitRepeat,
} from "../../engine/bridge.ts";
import { formatCents, todayIso } from "../../lib/format.ts";
import { ChipChoice } from "./ChipChoice.tsx";
import { shareEntry } from "./entryShare.ts";
import { type GroupMeta, guestSplit, MAX_WHAT, type ShownBill } from "./ledger.ts";
import { valuesOf } from "./splitValues.ts";
import {
  addBill,
  type BillDraft,
  deleteBill,
  editBill,
  METHODS,
  namesOf,
  organizerOf,
  partsOf,
  REPEATS,
  type SplitGroupOut,
  splitErrorText,
  stopRepeating,
  useSplitGroup,
} from "./useSplits.ts";

function typedFrom(bill: ShownBill): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, v] of Object.entries(bill.values ?? {}))
    out[p] = bill.method === "shares" ? String(v) : (v / 100).toFixed(2);
  return out;
}

/**
 * Add a bill (canvas "Add a bill"): 1 · How much? 2 · How to split it? 3 · Repeats? then what
 * it's for, who paid and when. The organizer picks the split and who takes a leftover cent;
 * anyone else's bill splits equally and waits for the organizer's OK ("Jordan sets how this
 * group splits"). With `billId` it is the organizer's Edit, with Delete and Stop repeating.
 */
export function AddSplitBill() {
  const { id, billId } = useParams();
  const [params] = useSearchParams();
  const entryId = billId ? null : params.get("entry");
  const { db } = useDb();
  const entry = useLiveQuery(
    async () => (entryId ? ((await db.entries.get(entryId)) ?? null) : null),
    [db, entryId],
  );
  const { splits, group, view, refresh } = useSplitGroup(id);
  if (!group || !view || !splits || entry === undefined) {
    return (
      <>
        <ScreenHeader
          title={billId ? "Edit bill" : "Add a bill"}
          actions={null}
          back={`/splits/${id}`}
        />
        <p className="sr-only" role="status">
          Loading
        </p>
      </>
    );
  }
  const editing = billId
    ? (view.merged.bills.find((b) => b.base_id === billId && b.id === b.base_id) ?? null)
    : null;
  if (billId && !editing) {
    return (
      <>
        <ScreenHeader title="Edit bill" actions={null} back={`/splits/${id}`} />
        <Card>
          <p>This bill isn't here any more.</p>
        </Card>
      </>
    );
  }
  return (
    <BillForm
      group={group}
      meta={view.merged.group}
      editing={editing}
      entry={entry && entry.direction === "out" && !entry.split_bill ? entry : null}
      doubleCheck={splits.double_check}
      today={splits.today}
      onSaved={refresh}
    />
  );
}

function BillForm({
  group,
  meta,
  editing,
  entry,
  doubleCheck,
  today,
  onSaved,
}: {
  group: SplitGroupOut;
  meta: GroupMeta | null;
  editing: ShownBill | null;
  /** Split on an entry: the bill starts from it, and saving splits it (invariant 76). */
  entry: Entry | null;
  doubleCheck: boolean;
  today: { added: number; limit: number };
  onSaved: () => Promise<void>;
}) {
  const { db } = useDb();
  const navigate = useNavigate();
  const nameOf = namesOf(group);
  const organizer = organizerOf(group);
  const runsIt = group.is_organizer;
  const live = group.members.map((m) => m.member_id);
  const back = `/splits/${group.id}`;
  const organizerName = group.members.find((m) => m.is_organizer)?.display_name ?? "The organizer";
  const leftoverRule = meta?.leftover ?? "payer";
  // A guest's bill follows the group's usual split, locked (S.6); the organizer starts from it.
  const usual = runsIt
    ? { method: meta?.usual_method ?? "equal", values: meta?.usual_values ?? null }
    : guestSplit(meta, live);
  const typedUsual = Object.fromEntries(
    Object.entries(usual.values ?? {}).map(([p, n]) => [
      p,
      usual.method === "shares" ? String(n) : (n / 100).toFixed(2),
    ]),
  );

  const start = editing?.amount_cents ?? entry?.amount_cents ?? null;
  const [amountText, setAmountText] = useState(start === null ? "" : (start / 100).toFixed(2));
  const [method, setMethod] = useState<SplitMethod>(editing?.method ?? usual.method);
  const [people, setPeople] = useState<string[]>(editing?.people ?? live);
  const [typed, setTyped] = useState<Record<string, string>>(
    editing ? typedFrom(editing) : typedUsual,
  );
  const [repeat, setRepeat] = useState<SplitRepeat | null>(editing?.repeat ?? null);
  const [what, setWhat] = useState(editing?.what ?? entry?.merchant.slice(0, MAX_WHAT) ?? "");
  const [paidBy, setPaidBy] = useState(editing?.paid_by ?? group.my_member_id);
  const [date, setDate] = useState(editing?.date ?? entry?.date ?? todayIso());
  const [leftover, setLeftover] = useState<string>(
    editing && editing.leftover_to !== editing.paid_by
      ? editing.leftover_to
      : leftoverRule !== "payer" && live.includes(leftoverRule)
        ? leftoverRule
        : "payer",
  );
  const [checked, setChecked] = useState(false);
  const [draft, setDraft] = useState<BillDraft | null>(null);
  const [parts, setParts] = useState<SplitPart[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The id the server issued when a save failed: Try again reuses it.
  const [issued, setIssued] = useState<{ id: string; status: "approved" | "pending" } | null>(null);

  const everyone = useMemo(() => {
    const all = [...live];
    for (const p of editing?.people ?? []) if (!all.includes(p)) all.push(p);
    return all;
  }, [live, editing]);

  // Work the parts out as they type, through the engine, so the preview is the saved split.
  useEffect(() => {
    let alive = true;
    void (async () => {
      let cents: number;
      try {
        cents = await parseAmount(amountText);
      } catch {
        cents = 0;
      }
      if (!alive) return;
      if (cents <= 0) {
        setDraft(null);
        setParts(null);
        setProblem(amountText.trim() ? "invalid_amount" : null);
        return;
      }
      const values = await valuesOf(method, people, typed);
      if (!alive) return;
      if (values === "bad") {
        setDraft(null);
        setParts(null);
        setProblem(method === "shares" ? "invalid_share" : "values_must_match_people");
        return;
      }
      const d: BillDraft = {
        date,
        what,
        amount_cents: cents,
        paid_by: paidBy,
        people,
        method,
        values,
        leftover_to: leftover === "payer" || !people.includes(leftover) ? paidBy : leftover,
        repeat,
      };
      const r = await partsOf(d);
      if (!alive) return;
      if ("error" in r) {
        setDraft(null);
        setParts(null);
        setProblem(r.error);
        return;
      }
      setDraft(d);
      setParts(r.parts);
      setProblem(null);
    })();
    return () => {
      alive = false;
    };
  }, [amountText, method, people, typed, date, what, paidBy, leftover, repeat]);

  const mine = parts?.find((p) => p.person === group.my_member_id)?.cents ?? 0;
  const atLimit = runsIt && !editing && today.limit > 0 && today.added >= today.limit;
  const ready = draft !== null && what.trim() !== "" && (!doubleCheck || checked) && !busy;

  async function save() {
    if (!draft) return;
    setBusy(true);
    const r = editing
      ? await editBill(db, group, editing, draft)
      : await addBill(db, group, draft, issued);
    if (!r.ok) {
      setBusy(false);
      const kept = "issued" in r ? (r.issued as typeof issued | undefined) : undefined;
      if (kept) setIssued(kept);
      setError(splitErrorText(r.code));
      return;
    }
    // Split on an entry I paid: only my share stays counted (invariant 76).
    if (
      entry &&
      "bill_id" in r &&
      draft.paid_by === group.my_member_id &&
      draft.amount_cents === entry.amount_cents
    )
      await shareEntry(db, entry.id, mine, `${group.id}:${r.bill_id}`);
    setBusy(false);
    await onSaved();
    navigate(back, { replace: true });
  }

  if (atLimit) {
    return (
      <>
        <ScreenHeader title="Add a bill" actions={null} back={back} />
        <Card role="status">
          <Word>Done</Word>
          <p>
            Done for today · {today.added} of {today.limit} bills added. More tomorrow at midnight.
          </p>
        </Card>
      </>
    );
  }

  const unit = method === "exact" ? "$" : method === "percent" ? "%" : "shares";
  return (
    <>
      <ScreenHeader title={editing ? "Edit bill" : "Add a bill"} actions={null} back={back} />
      {entry ? (
        <p className="auth__hint">
          From your entry · {entry.merchant} · {formatCents(entry.amount_cents)}. Saving keeps only
          your share in your spending.
        </p>
      ) : null}
      <label className="auth__field">
        <span className="auth__label">1 · How much?</span>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="186.00"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
        />
      </label>
      {runsIt ? (
        <ChipChoice
          legend="2 · How to split it?"
          options={METHODS}
          value={method}
          onChange={(v) => setMethod(v)}
        />
      ) : (
        <p className="auth__hint">
          {usual.method === "equal"
            ? `2 · Split equally. ${organizerName} sets how this group splits and approves your bill.`
            : `2 · Split by ${usual.method === "shares" ? "shares" : "percent"}: ${live
                .map(
                  (p) =>
                    `${nameOf(p)} ${usual.method === "shares" ? (usual.values?.[p] ?? 0) : `${(usual.values?.[p] ?? 0) / 100}%`}`,
                )
                .join(" · ")}. ${organizerName} sets how this group splits and approves your bill.`}
        </p>
      )}
      <fieldset className="split-people">
        <legend className="auth__label">Who's in?</legend>
        {everyone.map((p) => (
          <div className="split-person" key={p}>
            <label className="split-person__name">
              <input
                type="checkbox"
                checked={people.includes(p)}
                disabled={!runsIt}
                onChange={(e) =>
                  setPeople((list) =>
                    e.target.checked
                      ? everyone.filter((x) => list.includes(x) || x === p)
                      : list.filter((x) => x !== p),
                  )
                }
              />{" "}
              {nameOf(p)}
            </label>
            {method !== "equal" && people.includes(p) ? (
              <input
                className="auth__input"
                inputMode={method === "shares" ? "numeric" : "decimal"}
                aria-label={`${nameOf(p)}, ${unit}`}
                readOnly={!runsIt}
                value={typed[p] ?? ""}
                onChange={(e) => setTyped((t) => ({ ...t, [p]: e.target.value }))}
              />
            ) : null}
            {parts ? (
              <span className="split-preview">
                {formatCents(parts.find((x) => x.person === p)?.cents ?? 0)}
              </span>
            ) : null}
          </div>
        ))}
      </fieldset>
      {runsIt ? (
        <ChipChoice
          legend="3 · Repeats?"
          options={REPEATS}
          value={repeat}
          onChange={(v) => setRepeat(v)}
        />
      ) : null}
      <label className="auth__field">
        <span className="auth__label">What's it for?</span>
        <input
          className="auth__input"
          value={what}
          maxLength={MAX_WHAT}
          placeholder="Groceries"
          onChange={(e) => setWhat(e.target.value)}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">Who paid?</span>
        <select className="auth__input" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
          {everyone.map((p) => (
            <option key={p} value={p}>
              {nameOf(p)}
            </option>
          ))}
        </select>
      </label>
      <label className="auth__field">
        <span className="auth__label">{repeat ? "First date" : "Date"}</span>
        <input
          className="auth__input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      {runsIt && method !== "exact" ? (
        <label className="auth__field">
          <span className="auth__label">A leftover cent goes to</span>
          <select
            className="auth__input"
            value={leftover}
            onChange={(e) => setLeftover(e.target.value)}
          >
            <option value="payer">Whoever paid</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {nameOf(p)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {parts && people.includes(group.my_member_id) ? (
        <p role="status">Only {formatCents(mine)} counts as yours.</p>
      ) : null}
      {problem ? (
        <p className="auth__hint" role="status">
          {splitErrorText(problem)}
        </p>
      ) : null}
      {doubleCheck && !editing ? (
        <label className="auth__field">
          <span>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />{" "}
            Amount and people right?
          </span>
        </label>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={save} disabled={!ready || (doubleCheck && !editing && !checked)}>
        {editing ? "Save changes" : runsIt ? "Add bill" : `Send to ${organizerName}`}
      </Button>
      {editing && runsIt ? (
        <>
          {editing.repeat && !editing.repeat_until ? (
            <Button
              block
              variant="ghost"
              onClick={async () => {
                const r = await stopRepeating(db, group, editing);
                if (!r.ok) return setError(splitErrorText(r.code));
                await onSaved();
                navigate(back, { replace: true });
              }}
            >
              Stop repeating after today
            </Button>
          ) : null}
          <Button
            block
            variant="ghost"
            onClick={async () => {
              if (!confirmDelete) return setConfirmDelete(true);
              const r = await deleteBill(db, group, editing);
              if (!r.ok) return setError(splitErrorText(r.code));
              await onSaved();
              navigate(back, { replace: true });
            }}
          >
            <span style={{ color: "var(--c-danger)" }}>
              {confirmDelete ? "Really delete this bill for everyone" : "Delete bill"}
            </span>
          </Button>
        </>
      ) : null}
      {organizer === null ? null : (
        <p className="auth__fineprint">Everyone in the group sees this bill and its changes.</p>
      )}
    </>
  );
}
