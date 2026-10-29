import "./entries.css";

import { Button, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { recordDeletion } from "../../data/backup/snapshot.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { bankText, type Direction, type Entry, newId } from "../../data/db.ts";
import { deleteReceipts, deleteReceiptsOf } from "../../data/receipts.ts";
import { cleanDescription, EngineError, matchesRule, parseAmount } from "../../engine/bridge.ts";
import { formatCents, formatDay, todayIso } from "../../lib/format.ts";
import { emitMoment } from "../../moments/bus.ts";
import { CategorySheet } from "../categories/CategorySheet.tsx";
import { ReceiptCard } from "../receipts/ReceiptCard.tsx";
import { likeThis, renameEntry } from "./entryActions.ts";
import { ENTRIES_PATH } from "./paths.ts";
import { centsBackToParent, splitTree } from "./splits.ts";
import { TagField } from "./TagField.tsx";
import { NOTE_MAX } from "./tags.ts";
import { findTransferPartner, releasePartners } from "./transfers.ts";
import { accountLabel } from "./useEntries.ts";

/**
 * Add entry (mockup F5Receipt), also the editor for an existing entry at /entries/:id.
 * Money out or in, amount, merchant, date, account, category. Saved on this device only;
 * the amount is parsed by the rules engine so "1,234.56" means the same everywhere.
 * The receipt photo card keeps the photo on this device (chunk 1.9).
 */
export function AddEntrySheet() {
  const { id: editId } = useParams();
  const [params] = useSearchParams();
  const withReceipt = params.get("with") === "receipt"; // opened from "+ → A receipt"
  const navigate = useNavigate();
  const { db } = useDb();
  const ids = useId();
  // undefined while the device database answers, null when there is no such entry.
  const found = useLiveQuery<Entry | null | undefined>(
    async () => (editId ? ((await db.entries.get(editId)) ?? null) : null),
    [db, editId],
  );
  const existing = found ?? undefined;
  const accounts = useLiveQuery(() => db.accounts.orderBy("type").toArray(), [db]);
  const categories = useLiveQuery(() => db.categories.orderBy("[kind+sort]").toArray(), [db]);
  const knownTags = useLiveQuery(
    async () => (await db.entries.orderBy("tags").uniqueKeys()).map(String).sort(),
    [db],
  );

  const [direction, setDirection] = useState<Direction>("out");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isTransfer, setIsTransfer] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitAmount, setSplitAmount] = useState("");
  const [splitCategoryId, setSplitCategoryId] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [alwaysRule, setAlwaysRule] = useState(false); // fast-follow 7: correction -> rule
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [isCounted, setIsCounted] = useState(true);
  const [renameAll, setRenameAll] = useState(true);
  const [alike, setAlike] = useState(0);
  // Opened from a row's "Duplicate?": the entry it looks like.
  const duplicateId = params.get("duplicate");
  const twin = useLiveQuery(
    async () => (duplicateId ? ((await db.entries.get(duplicateId)) ?? null) : null),
    [db, duplicateId],
  );

  useEffect(() => {
    if (existing && existing.id !== loadedId) {
      setDirection(existing.direction);
      setAmount((existing.amount_cents / 100).toFixed(2));
      setMerchant(existing.merchant);
      setDate(existing.date);
      setAccountId(existing.account_id);
      setCategoryId(existing.category_id);
      setIsTransfer(existing.is_transfer);
      setReceiptId(existing.receipt_id);
      setNote(existing.note ?? "");
      setTags(existing.tags ?? []);
      setIsCounted(!existing.not_counted);
      setRenameAll(true);
      setAlwaysRule(false);
      void likeThis(db, existing).then((rows) => setAlike(rows.length));
      setLoadedId(existing.id);
    }
  }, [existing, loadedId, db]);

  useEffect(() => {
    if (!accountId && accounts?.[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  // A hidden built-in category stays offered only on an entry already in it.
  const visibleCategories = (categories ?? []).filter(
    (c) =>
      c.kind === (direction === "out" ? "expense" : "income") &&
      (!c.hidden || c.id === existing?.category_id),
  );
  const [newCategory, setNewCategory] = useState<"main" | "split" | null>(null);
  const renamed = Boolean(existing && merchant.trim() && merchant.trim() !== existing.merchant);
  const title = editId ? "Edit entry" : withReceipt ? "Add entry from a receipt" : "Add entry";

  // Fast-follow 7 (spec "Statement import": a correction can become a rule): offered when an
  // existing entry's category is changed and the entry has a merchant to match on.
  const correctionOffer = Boolean(
    existing &&
      !isTransfer &&
      categoryId &&
      categoryId !== existing.category_id &&
      existing.merchant.trim(),
  );

  function categoryName(id: string | null): string {
    return (categories ?? []).find((c) => c.id === id)?.name ?? "this category";
  }

  /** Writes the rule and moves past uncategorized entries that match it. */
  async function applyAlwaysRule(entryId: string, chosenCategory: string) {
    if (!alwaysRule || !correctionOffer || !existing) return;
    // The bank's text, so a renamed entry's rule still meets the next import (invariant 47).
    const match = bankText(existing).trim();
    const stamp = new Date().toISOString();
    await db.merchant_rules.put({
      id: newId(),
      match,
      category_id: chosenCategory,
      created_at: stamp,
    });
    const cleanedMatch = await cleanDescription(match);
    if (!cleanedMatch) return;
    const candidates = await db.entries
      .filter((row) => row.category_id === null && !row.is_transfer && row.id !== entryId)
      .toArray();
    const moved: string[] = [];
    // Exactly as the categorizer reads the rule: a whole word, cleaned or as a merchant key.
    for (const row of candidates) if (await matchesRule(bankText(row), match)) moved.push(row.id);
    if (moved.length > 0) {
      await db.entries
        .where("id")
        .anyOf(moved)
        .modify({ category_id: chosenCategory, updated_at: stamp });
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let cents: number;
    try {
      cents = await parseAmount(amount);
    } catch (err) {
      setError(
        err instanceof EngineError ? "Enter an amount like 42.17." : "Couldn't read that amount.",
      );
      return;
    }
    if (cents <= 0) {
      setError("Enter an amount above zero.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a date.");
      return;
    }
    if (!accountId) {
      setError("Pick an account.");
      return;
    }
    let splitCents = 0;
    if (splitOpen && existing && !isTransfer) {
      try {
        splitCents = await parseAmount(splitAmount);
      } catch {
        setError("Enter the amount to split off, like 10.00.");
        return;
      }
      if (splitCents <= 0 || splitCents >= cents) {
        setError("The split amount must be more than zero and less than the total.");
        return;
      }
    }
    // A part's amount comes out of the entry it was split from: a new amount moves the difference
    // there, so the two still add up to the bank's row (rule 1).
    const parentId = existing?.split_parent_id ?? null;
    const back = parentId && existing ? existing.amount_cents - cents : 0;
    if (parentId && back < 0) {
      const parent = await db.entries.get(parentId);
      if (parent && parent.amount_cents + back <= 0) {
        setError("A part can't be more than what's left on the entry it was split from.");
        return;
      }
    }
    const now = new Date().toISOString();
    const giveBack = async () => {
      if (!parentId || back === 0) return;
      await db.entries
        .where("id")
        .equals(parentId)
        .modify((p) => {
          p.amount_cents += back;
          p.updated_at = now;
        });
    };
    const name = merchant.trim() || (direction === "in" ? "Money in" : "Money out");
    const entry: Entry = {
      // Keep what this screen doesn't edit (a linked row's provider id and pending flag).
      ...existing,
      id: existing?.id ?? newId(),
      date,
      amount_cents: cents - splitCents,
      direction,
      merchant: name,
      // An imported or linked entry keeps its bank text as the key that names and rules match on.
      clean_description:
        existing && existing.source !== "manual" ? existing.clean_description : name,
      renamed: existing ? existing.renamed || name !== existing.merchant : undefined,
      raw_description: existing?.raw_description ?? null,
      category_id: isTransfer ? null : categoryId,
      account_id: accountId,
      source: existing?.source ?? "manual",
      receipt_id: receiptId,
      import_id: existing?.import_id ?? null,
      is_transfer: isTransfer,
      transfer_pair_id: existing?.transfer_pair_id ?? null,
      split_parent_id: existing?.split_parent_id ?? null,
      is_recurring: existing?.is_recurring ?? false,
      note: note.trim() ? note.trim().slice(0, NOTE_MAX) : null,
      tags,
      not_counted: isCounted ? undefined : true,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing?.fingerprint) entry.fingerprint = existing.fingerprint;
    if (splitCents > 0) {
      // the split part is a second entry, same date and account, pointing back at this one
      const part: Entry = {
        ...entry,
        id: newId(),
        amount_cents: splitCents,
        category_id: splitCategoryId,
        split_parent_id: entry.id,
        created_at: now,
      };
      part.fingerprint = undefined;
      // The bank's id stays on the entry it belongs to; a sync updates that one and the parts
      // follow it (linking/sync.ts settleSplits), never a part on its own.
      delete part.provider_txn_id;
      delete part.pending;
      await db.transaction("rw", db.entries, async () => {
        await db.entries.put(entry);
        await db.entries.put(part);
        await giveBack();
      });
      if (entry.category_id) await applyAlwaysRule(entry.id, entry.category_id);
      await attachReceipt(entry.id);
      navigate(ENTRIES_PATH, { replace: true });
      return;
    }
    if (existing?.is_transfer && !entry.is_transfer && entry.transfer_pair_id) {
      // Not a transfer after all: the other side goes back to money in or out with it.
      const pairId = entry.transfer_pair_id;
      entry.transfer_pair_id = null;
      await db.transaction("rw", db.entries, async () => {
        await db.entries.put(entry);
        await giveBack();
        const other = await db.entries.get(pairId);
        if (other?.transfer_pair_id === entry.id)
          await db.entries.put({
            ...other,
            is_transfer: false,
            transfer_pair_id: null,
            updated_at: now,
          });
      });
    } else if (entry.is_transfer && !existing?.is_transfer && !entry.transfer_pair_id) {
      // Marked a transfer by hand: the matching other side is marked and paired with it, so the
      // money isn't still counted as in or out on that side (October 27, 2026).
      const partner = await findTransferPartner(db, entry);
      await db.transaction("rw", db.entries, async () => {
        const other = partner ? await db.entries.get(partner.id) : undefined;
        if (other && !other.is_transfer && !other.transfer_pair_id) {
          entry.transfer_pair_id = other.id;
          await db.entries.put({
            ...other,
            is_transfer: true,
            category_id: null,
            transfer_pair_id: entry.id,
            updated_at: now,
          });
        }
        await db.entries.put(entry);
        await giveBack();
      });
    } else
      await db.transaction("rw", db.entries, async () => {
        await db.entries.put(entry);
        await giveBack();
      });
    // A new name for an imported entry can rename every entry like it, now and in future imports.
    if (existing && renamed && renameAll && alike > 0)
      await renameEntry(db, existing, entry.merchant, true);
    if (entry.category_id) await applyAlwaysRule(entry.id, entry.category_id);
    await attachReceipt(entry.id);
    if (!existing && entry.direction === "in" && !entry.is_transfer)
      emitMoment("income_logged", { amount: formatCents(entry.amount_cents) }, entry.id);
    navigate(ENTRIES_PATH, { replace: true });
  }

  /**
   * The receipt row points at its entry once the entry exists. A photo replaced by another goes
   * with its receipt, and so does one the person removed (the card already deleted it; this
   * catches any left over) (spec "Receipts").
   */
  async function attachReceipt(entryId: string) {
    const stamp = new Date().toISOString();
    if (existing?.receipt_id && existing.receipt_id !== receiptId) {
      const old = existing.receipt_id;
      await db.transaction("rw", [db.receipts, db.files], () => deleteReceipts(db, [old]));
    }
    if (receiptId) {
      await db.receipts.update(receiptId, {
        entry_id: entryId,
        status: "confirmed",
        updated_at: stamp,
      });
    }
  }

  async function remove() {
    if (!existing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await db.transaction("rw", [db.entries, db.tombstones, db.receipts, db.files], async () => {
      // Its split parts are pieces of it, so they go with it (a part's parts too)
      const parts = splitTree(await db.entries.filter((e) => !!e.split_parent_id).toArray());
      const mine = parts([existing.id]);
      const ids = [existing.id, ...mine.map((p) => p.id)];
      // A part is a piece of the entry it was split from: its money (and its parts') goes back
      // there, so the bank's row is still counted whole.
      const self = await db.entries.get(existing.id);
      const parent = self?.split_parent_id ? await db.entries.get(self.split_parent_id) : undefined;
      if (self && parent)
        await db.entries.put({
          ...parent,
          amount_cents: parent.amount_cents + centsBackToParent(self, mine),
          updated_at: new Date().toISOString(),
        });
      await deleteReceiptsOf(db, ids);
      await db.entries.bulkDelete(ids);
      await recordDeletion(db, "entries", ids);
      await releasePartners(db, ids);
    });
    navigate(ENTRIES_PATH, { replace: true });
  }

  // An entry being edited shows its form only once its values are in: typing into fields the
  // load is about to fill would be overwritten (invariant 18, October 27, 2026).
  if (editId && (found === undefined || (found && loadedId !== found.id)))
    return (
      <>
        <ScreenHeader title={title} actions={null} back={ENTRIES_PATH} />
        <p className="auth__hint" role="status">
          Opening the entry…
        </p>
      </>
    );
  if (editId && found === null)
    return (
      <>
        <ScreenHeader title={title} actions={null} back={ENTRIES_PATH} />
        <p className="auth__hint" role="status">
          This entry isn't on this device any more.
        </p>
      </>
    );

  return (
    <>
      <ScreenHeader title={title} actions={null} back={editId ? ENTRIES_PATH : "/"} />
      <form onSubmit={save} className="auth__field" noValidate style={{ gap: 12 }}>
        <fieldset className="segmented" style={{ border: 0, margin: 0 }}>
          <legend className="sr-only">Direction</legend>
          {(
            [
              ["out", "Money out"],
              ["in", "Money in"],
            ] as const
          ).map(([value, label]) => (
            <label className="segmented__option" key={value}>
              <input
                className="segmented__input"
                type="radio"
                name={`${ids}-direction`}
                value={value}
                checked={direction === value}
                onChange={() => {
                  setDirection(value);
                  setCategoryId(null);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <label className="amount">
          <span className="amount__sign" aria-hidden="true">
            $
          </span>
          <input
            className="amount__input"
            aria-label="Amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </label>

        <div className="fields">
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-merchant`}>
              Merchant
            </label>
            <input
              id={`${ids}-merchant`}
              className="field__input"
              placeholder="e.g. Corner Market"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-date`}>
              Date
            </label>
            <input
              id={`${ids}-date`}
              className="field__input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-account`}>
              Account
            </label>
            <select
              id={`${ids}-account`}
              className="field__input"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {accountLabel(a)}
                </option>
              ))}
            </select>
          </div>
          <fieldset
            className="chips"
            style={{ border: 0, margin: 0, padding: "12px 0 8px" }}
            hidden={isTransfer}
          >
            <legend className="sr-only">Category</legend>
            {visibleCategories.map((c) => (
              <label className="chip-option" key={c.id}>
                <input
                  className="segmented__input"
                  type="radio"
                  name={`${ids}-category`}
                  value={c.id}
                  checked={categoryId === c.id}
                  onChange={() => setCategoryId(c.id)}
                />
                {c.name}
              </label>
            ))}
            <button type="button" className="chip-option" onClick={() => setNewCategory("main")}>
              + New
            </button>
          </fieldset>
          {correctionOffer ? (
            <Toggle
              label={`Always put ${existing?.merchant} in ${categoryName(categoryId)}`}
              description="Becomes one of your category rules: future imports use it, and past uncategorized entries that match move too"
              checked={alwaysRule}
              onChange={setAlwaysRule}
            />
          ) : null}
        </div>

        <div className="fields">
          <TagField tags={tags} known={knownTags ?? []} onChange={setTags} />
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-note`}>
              Note
            </label>
            <textarea
              id={`${ids}-note`}
              className="field__input entry-note"
              rows={2}
              maxLength={NOTE_MAX}
              placeholder="Anything to remember, only on this device"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        {existing && renamed && alike > 0 ? (
          <div className="fields">
            <Toggle
              label={`Rename all ${alike + 1} like this`}
              description="Future statements and bank updates use this name too"
              checked={renameAll}
              onChange={setRenameAll}
            />
          </div>
        ) : null}
        <div className="fields">
          <Toggle
            label="Count in my spending"
            description="Off: left out of totals, budgets and insights; still in your balance"
            checked={isCounted}
            onChange={setIsCounted}
          />
          <Toggle
            label="Transfer between my accounts"
            description="Not counted as money in or out"
            checked={isTransfer}
            onChange={(on) => {
              setIsTransfer(on);
              if (on) setSplitOpen(false);
            }}
          />
        </div>
        {existing && !isTransfer ? (
          <div className="fields">
            {splitOpen ? (
              <div className="auth__field" style={{ padding: "10px 0" }}>
                <label className="auth__label" htmlFor={`${ids}-split`}>
                  Split off amount
                </label>
                <input
                  id={`${ids}-split`}
                  className="auth__input"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={splitAmount}
                  onChange={(e) => setSplitAmount(e.target.value)}
                />
                <fieldset className="chips" style={{ border: 0, margin: 0, padding: "4px 0" }}>
                  <legend className="sr-only">Category for the split part</legend>
                  {visibleCategories.map((c) => (
                    <label className="chip-option" key={`split-${c.id}`}>
                      <input
                        className="segmented__input"
                        type="radio"
                        name={`${ids}-split-category`}
                        value={c.id}
                        checked={splitCategoryId === c.id}
                        onChange={() => setSplitCategoryId(c.id)}
                      />
                      {c.name}
                    </label>
                  ))}
                </fieldset>
                <p className="auth__hint">The rest stays with this entry.</p>
                <Button type="button" variant="ghost" size="sm" onClick={() => setSplitOpen(false)}>
                  Don't split
                </Button>
              </div>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setSplitOpen(true)}>
                Split this entry
              </Button>
            )}
          </div>
        ) : null}
        <ReceiptCard
          receiptId={receiptId}
          onChange={setReceiptId}
          onSuggest={(s) => {
            // Read off the photo on this device; the user checks each field before saving.
            if (s.total) setAmount(s.total);
            if (s.merchant) setMerchant(s.merchant);
            if (s.date) setDate(s.date);
          }}
        />
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" block>
          Save
        </Button>
        <p className="auth__fineprint">Saved on this device only.</p>
        {existing && twin ? (
          <p className="auth__hint" role="note">
            Looks like a duplicate of {twin.merchant} on {formatDay(twin.date)} (
            {accountLabel(accounts?.find((a) => a.id === twin.account_id))}). If it is, delete this
            one: your balance stays right.
          </p>
        ) : null}
        {existing ? (
          <Button type="button" variant="ghost" block onClick={remove}>
            <span style={{ color: "var(--c-danger)" }}>
              {confirmDelete ? "Really delete this entry" : "Delete entry"}
            </span>
          </Button>
        ) : null}
      </form>
      <CategorySheet
        open={newCategory !== null}
        onClose={() => setNewCategory(null)}
        kind={direction === "out" ? "expense" : "income"}
        all={categories ?? []}
        onCreated={(c) =>
          newCategory === "split" ? setSplitCategoryId(c.id) : setCategoryId(c.id)
        }
      />
    </>
  );
}
