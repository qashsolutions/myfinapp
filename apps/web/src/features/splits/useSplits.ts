/**
 * Split bills on the screen (chunk S.3b): the server's list of groups, one group's merged view,
 * and every change a person makes. Names of groups, bills, amounts and splits live only in the
 * encrypted ledgers (invariant 78); the server sees ids, members and opaque bytes.
 */

import type { components } from "@stackd/api-client";
import { collapseSpaces, trimSpaces } from "@stackd/rules/text";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiFailure, api, clientFor, failureOf } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import type { StackdDb } from "../../data/db.ts";
import {
  type SplitMethod,
  type SplitRepeat,
  splitRepeatDates,
  splitShare,
} from "../../engine/bridge.ts";
import { todayIso } from "../../lib/format.ts";
import {
  asBill,
  canUndo,
  type GroupMeta,
  type LedgerBlob,
  NOTE_MAX,
  type PayApp,
  type ShownBill,
  type SplitBill,
  takeOverLedger,
} from "./ledger.ts";
import { removeSettleSpending } from "./settleSpending.ts";
import {
  forgetGroupBlobs,
  newGroupKey,
  pullGroup,
  type SplitView,
  updateMyLedger,
} from "./splitSync.ts";

export type SplitsOut = components["schemas"]["SplitsOut"];
export type SplitGroupOut = components["schemas"]["SplitGroupOut"];
export type SplitMemberOut = components["schemas"]["SplitMemberOut"];

/**
 * What a group is for (owner, November 11, 2026): suggestions plus the person's own, kept in the
 * encrypted group settings as a chip's id or `own:<text>`. Friends and Family left the list (they
 * say who, not what); a group saved with them, or with Other, still reads so in the box.
 */
export const GROUP_KINDS: Array<[string, string]> = [
  ["home", "Home & rent"],
  ["trip", "Trip"],
  ["dining", "Restaurant"],
];

export const KIND_OWN_MAX = 24;
const OWN = "own:";
const OLD_KINDS: Readonly<Record<string, string>> = {
  friends: "Friends",
  family: "Family",
  other: "Other",
};

/** A saved kind as the person's own words in the box ("" for a chip or none). */
export function ownKindText(kind: string): string {
  return kind.startsWith(OWN) ? kind.slice(OWN.length) : (OLD_KINDS[kind] ?? "");
}

/** The box's text as a kind: a chip when it names one, else `own:<text>`; 1–24 characters. */
export function parseOwnKind(text: string): { value: string } | { error: string } {
  const clean = trimSpaces(collapseSpaces(text));
  if (!clean) return { error: "Name what it's for." };
  if (clean.length > KIND_OWN_MAX) return { error: `Keep it to ${KIND_OWN_MAX} characters.` };
  const chip = GROUP_KINDS.find(([, label]) => label.toLowerCase() === clean.toLowerCase());
  return { value: chip ? chip[0] : `${OWN}${clean}` };
}

export const METHODS: ReadonlyArray<readonly [SplitMethod, string]> = [
  ["equal", "Equally"],
  ["exact", "Exact"],
  ["percent", "Percent"],
  ["shares", "Shares"],
];

export const REPEATS: ReadonlyArray<readonly [SplitRepeat | null, string]> = [
  [null, "Once"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["yearly", "Yearly"],
];

export const PAY_APPS: ReadonlyArray<readonly [PayApp, string]> = [
  ["venmo", "Venmo"],
  ["cashapp", "Cash App"],
  ["paypal", "PayPal"],
  ["other", "Cash or other"],
];

export const MAX_NAME = 40;

/** The list from the server; the tab and Home read it. */
export function useSplits(options: { background?: boolean } = {}): {
  splits: SplitsOut | null;
  error: ApiFailure | null;
  refresh: () => Promise<SplitsOut | null>;
} {
  const [splits, setSplits] = useState<SplitsOut | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const background = options.background ?? false;
  // A screen that is gone takes no late answer (November 10, 2026).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const r = await clientFor(background).GET("/api/splits");
    const failure = failureOf(r);
    if (failure || !r.data) {
      if (mounted.current) setError(failure);
      return null;
    }
    if (mounted.current) {
      setSplits(r.data);
      setError(null);
    }
    return r.data;
  }, [background]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { splits, error, refresh };
}

export function organizerOf(group: SplitGroupOut): string | null {
  return group.members.find((m) => m.is_organizer)?.member_id ?? null;
}

/**
 * Whose ledger's settings, corrections and approvals count: the organizer's, or while nobody
 * runs the group the previous organizer's, so their leaving never brings back a deleted bill
 * (S.6, November 10, 2026).
 */
export function authorityOf(group: SplitGroupOut): string | null {
  return organizerOf(group) ?? group.previous_organizer_member_id ?? null;
}

/** Member id → the name this device shows; anyone a bill names who has left is a former member. */
export function namesOf(group: SplitGroupOut): (memberId: string) => string {
  const byId = new Map(group.members.map((m) => [m.member_id, m]));
  return (id) => {
    const m = byId.get(id);
    if (!m) return "Former member";
    return m.is_me ? "You" : m.display_name;
  };
}

export async function viewOf(
  db: StackdDb,
  group: SplitGroupOut,
  background = false,
): Promise<SplitView | null> {
  return pullGroup(
    db,
    group.id,
    {
      memberId: group.my_member_id,
      organizer: authorityOf(group),
      live: group.members.map((m) => m.member_id),
    },
    todayIso(),
    background,
  );
}

/** Each group's merged view, for the tab and Home: names and my balance per group. */
export function useSplitViews(groups: SplitGroupOut[] | null, background = true) {
  const { db } = useDb();
  const [views, setViews] = useState<Map<string, SplitView>>(new Map());
  // The groups' identity: the array itself is new on every read.
  const key = groups?.map((g) => `${g.id}:${g.members.length}`).join(",") ?? null;
  const current = useRef(groups);
  current.current = groups;
  useEffect(() => {
    const list = current.current;
    if (key === null || !list) return;
    let alive = true;
    void (async () => {
      // A few groups at a time: each one that hasn't changed is a list of versions (S.5).
      const next = new Map<string, SplitView>();
      for (let i = 0; i < list.length; i += 4) {
        const batch = list.slice(i, i + 4);
        const got = await Promise.all(batch.map((g) => viewOf(db, g, background)));
        got.forEach((view, j) => {
          const g = batch[j];
          if (view && g) next.set(g.id, view);
        });
      }
      if (alive) setViews(next);
    })();
    return () => {
      alive = false;
    };
  }, [db, key, background]);
  return views;
}

export function myBalance(view: SplitView | undefined, group: SplitGroupOut): number {
  return view?.balances.find((b) => b.person === group.my_member_id)?.cents ?? 0;
}

/** One group: the server's row, its merged view, and a refresh that re-reads both. */
export function useSplitGroup(groupId: string | undefined) {
  const { db } = useDb();
  const [splits, setSplits] = useState<SplitsOut | null>(null);
  const [view, setView] = useState<SplitView | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    if (!groupId) return;
    const mine = ++latest.current;
    const r = await api.GET("/api/splits");
    if (mine !== latest.current) return;
    const failure = failureOf(r);
    if (failure || !r.data) {
      setError(failure);
      return;
    }
    const group = r.data.groups.find((g) => g.id === groupId);
    setSplits(r.data);
    if (!group) {
      setError({ status: 404, code: "not_found" });
      return;
    }
    const next = await viewOf(db, group);
    if (mine !== latest.current) return;
    setView(next);
    setError(next ? null : { status: 0, code: "offline" });
  }, [db, groupId]);
  useEffect(() => {
    void refresh();
    return () => {
      latest.current++; // gone: any refresh still out is out of date
    };
  }, [refresh]);
  const group = splits?.groups.find((g) => g.id === groupId) ?? null;
  return { splits, group, view, error, refresh };
}

// ---- changes ----

export type Result = { ok: true } | { ok: false; code: string };
const fail = (code: string): Result => ({ ok: false, code });
const OK: Result = { ok: true };

function codeOf(failure: ApiFailure | null): string {
  return failure?.code ?? "failed";
}

/** A new group: the server's row, then the key made here, then the group's name in my ledger. */
export async function createSplitGroup(
  db: StackdDb,
  meta: Omit<GroupMeta, "updated_at">,
): Promise<{ ok: true; group: SplitGroupOut } | { ok: false; code: string }> {
  const r = await api.POST("/api/splits");
  const failure = failureOf(r);
  if (failure || !r.data) return fail(codeOf(failure)) as { ok: false; code: string };
  const group = r.data;
  await newGroupKey(db, group.id);
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
    ...l,
    group: { ...meta, updated_at: new Date().toISOString() },
  }));
  if (!saved) return { ok: false, code: "not_saved" };
  return { ok: true, group };
}

export async function saveGroupMeta(
  db: StackdDb,
  group: SplitGroupOut,
  meta: Omit<GroupMeta, "updated_at">,
): Promise<Result> {
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
    ...l,
    group: { ...meta, updated_at: new Date().toISOString() },
  }));
  return saved ? OK : fail("not_saved");
}

export interface BillDraft {
  date: string;
  what: string;
  amount_cents: number;
  paid_by: string;
  people: string[];
  method: SplitMethod;
  values: Record<string, number> | null;
  leftover_to: string;
  repeat: SplitRepeat | null;
}

/** The parts through the engine; null with the rule's error code when they don't add up. */
export async function partsOf(
  d: BillDraft,
): Promise<{ parts: SplitBill["parts"] } | { error: string }> {
  try {
    const { parts } = await splitShare(
      d.amount_cents,
      d.method,
      d.people,
      d.leftover_to,
      d.method === "equal" ? null : d.values,
    );
    return { parts };
  } catch (e) {
    return { error: (e as { code?: string }).code ?? "invalid_share" };
  }
}

/** Add a bill: an id from the server (counted, or waiting for the organizer), then the bill in
 * my own ledger. The organizer's counts at once; anyone else's waits (invariant 77). */
export async function addBill(
  db: StackdDb,
  group: SplitGroupOut,
  draft: BillDraft,
  /** An id the server already issued for this bill when its save failed: try again with it,
   * so a retry never spends another of the day's bills (November 9, 2026). */
  issued: { id: string; status: "approved" | "pending" } | null = null,
): Promise<
  | { ok: true; status: "approved" | "pending"; bill_id: string }
  | { ok: false; code: string; issued?: { id: string; status: "approved" | "pending" } }
> {
  const parts = await partsOf(draft);
  if ("error" in parts) return { ok: false, code: parts.error };
  if (draft.repeat) {
    // A repeat with too many dates to add at once (a first date years back) is refused here.
    const many = await splitRepeatDates(draft.date, draft.repeat, todayIso()).then(
      () => false,
      () => true,
    );
    if (many) return { ok: false, code: "too_many_dates" };
  }
  if (!issued) {
    const r = await api.POST("/api/splits/{group_id}/bills", {
      params: { path: { group_id: group.id } },
    });
    const failure = failureOf(r);
    if (failure || !r.data) return { ok: false, code: codeOf(failure) };
    issued = { id: r.data.id, status: r.data.status };
  }
  const bill: SplitBill = {
    ...draft,
    id: issued.id,
    what: draft.what.trim(),
    parts: parts.parts,
    repeat_until: null,
    added_by: group.my_member_id,
    updated_at: new Date().toISOString(),
  };
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
    ...l,
    bills: [...l.bills.filter((b) => b.id !== bill.id), bill],
  }));
  if (!saved) return { ok: false, code: "not_saved", issued };
  return { ok: true, status: issued.status, bill_id: issued.id };
}

/** The organizer's correction of any bill (pending ones too); a repeat's copies follow it. */
export async function editBill(
  db: StackdDb,
  group: SplitGroupOut,
  bill: ShownBill,
  draft: BillDraft,
): Promise<Result> {
  const parts = await partsOf(draft);
  if ("error" in parts) return fail(parts.error);
  const corrected: SplitBill = {
    ...draft,
    id: bill.base_id,
    what: draft.what.trim(),
    parts: parts.parts,
    repeat_until: bill.repeat_until,
    added_by: bill.added_by,
    updated_at: new Date().toISOString(),
  };
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
    ...l,
    edits: { ...l.edits, [bill.base_id]: corrected },
  }));
  return saved ? OK : fail("not_saved");
}

export async function deleteBill(
  db: StackdDb,
  group: SplitGroupOut,
  bill: ShownBill,
): Promise<Result> {
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
    ...l,
    edits: { ...l.edits, [bill.base_id]: null },
  }));
  return saved ? OK : fail("not_saved");
}

/** No copies after today: the organizer stops a repeating bill. */
export async function stopRepeating(
  db: StackdDb,
  group: SplitGroupOut,
  bill: ShownBill,
): Promise<Result> {
  const base_id = bill.base_id;
  const first: SplitBill = asBill(bill);
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => {
    const current = l.edits[base_id] ?? first;
    return {
      ...l,
      edits: {
        ...l.edits,
        [base_id]: {
          ...current,
          date: current.date,
          repeat_until: todayIso(),
          updated_at: new Date().toISOString(),
        },
      },
    };
  });
  return saved ? OK : fail("not_saved");
}

/**
 * Approve or decline someone else's bill. Approving first pins the bill as the organizer sees
 * it into the organizer's own ledger, so its author can't change it afterwards (invariant 77).
 */
export async function decideBill(
  db: StackdDb,
  group: SplitGroupOut,
  bill: ShownBill,
  decision: "approve" | "decline",
): Promise<Result> {
  if (decision === "approve") {
    const base_id = bill.base_id;
    // Stamped with when it was approved: the bill's history shows it (S.6).
    const pinned: SplitBill = { ...asBill(bill), updated_at: new Date().toISOString() };
    const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
      ...l,
      approved: { ...(l.approved ?? {}), [base_id]: pinned },
    }));
    if (!saved) return fail("not_saved");
  }
  const params = { params: { path: { group_id: group.id, bill_id: bill.base_id } } };
  const r =
    decision === "approve"
      ? await api.POST("/api/splits/{group_id}/bills/{bill_id}/approve", params)
      : await api.POST("/api/splits/{group_id}/bills/{bill_id}/decline", params);
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

/** A payment recorded on this device. It counts when I'm the person paid or the organizer;
 * recorded by the payer it is a claim until the person paid confirms it. */
export async function recordPayment(
  db: StackdDb,
  group: SplitGroupOut,
  p: {
    from: string;
    to: string;
    cents: number;
    via: PayApp;
    confirms?: string | null;
    note?: string | null;
  },
): Promise<{ ok: true; id: string } | { ok: false; code: string }> {
  if (p.cents <= 0 || p.from === p.to) return { ok: false, code: "invalid_amount" };
  const settlement = {
    id: crypto.randomUUID(),
    from: p.from,
    to: p.to,
    cents: p.cents,
    date: todayIso(),
    via: p.via,
    confirms: p.confirms ?? null,
    at: new Date().toISOString(),
    ...(p.note?.trim() ? { note: p.note.trim().slice(0, NOTE_MAX) } : {}),
  };
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l: LedgerBlob) => ({
    ...l,
    settlements: [...l.settlements, settlement],
  }));
  return saved ? { ok: true, id: settlement.id } : { ok: false, code: "not_saved" };
}

/**
 * Run this group (S.6): copy what the previous organizer decided into my own ledger first, so
 * every device shows the same group once I run it, then ask the server.
 */
export async function takeOver(
  db: StackdDb,
  group: SplitGroupOut,
  previous: { memberId: string; ledger: LedgerBlob } | null,
): Promise<Result> {
  if (previous) {
    const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) =>
      takeOverLedger(l, previous.ledger, previous.memberId),
    );
    if (!saved) return fail("not_saved");
  }
  const r = await api.POST("/api/splits/{group_id}/takeover", {
    params: { path: { group_id: group.id } },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

/**
 * Undo a payment I recorded (S.7): within UNDO_DAYS it is marked undone in my ledger, so it
 * moves nobody and History says so, and its "Paid <name>" spending entry goes with it.
 */
export async function undoPayment(
  db: StackdDb,
  group: SplitGroupOut,
  settlementId: string,
): Promise<Result> {
  let allowed = false;
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
    ...l,
    settlements: l.settlements.map((s) => {
      if (s.id !== settlementId || !canUndo(s, group.my_member_id, group.my_member_id, new Date()))
        return s;
      allowed = true;
      return { ...s, undone_at: new Date().toISOString() };
    }),
  }));
  if (!saved) return fail("not_saved");
  if (!allowed) return fail("undo_closed");
  await removeSettleSpending(db, group.id, settlementId);
  return OK;
}

/** My note on a bill I dispute (S.7), kept in my own ledger next to the server's dispute row. */
export async function saveDisputeNote(
  db: StackdDb,
  group: SplitGroupOut,
  billId: string,
  note: string,
): Promise<Result> {
  const clean = note.trim().slice(0, NOTE_MAX);
  if (!clean) return OK;
  const saved = await updateMyLedger(db, group.id, group.my_member_id, (l) => ({
    ...l,
    dispute_notes: { ...(l.dispute_notes ?? {}), [billId]: clean },
  }));
  return saved ? OK : fail("not_saved");
}

/**
 * S.10: tell another member in fixed words that I say I paid them ("paid") or that their
 * payment counts now ("confirmed"). Best effort: a payment is recorded whether or not the
 * push goes.
 */
export async function notifyMember(
  groupId: string,
  kind: "paid" | "confirmed",
  memberId: string,
): Promise<void> {
  await api.POST("/api/splits/{group_id}/notify", {
    params: { path: { group_id: groupId } },
    body: { kind, member_id: memberId },
  });
}

export async function remind(groupId: string, memberId: string): Promise<Result> {
  const r = await api.POST("/api/splits/{group_id}/remind", {
    params: { path: { group_id: groupId } },
    body: { member_id: memberId },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

export async function removeFromGroup(groupId: string, memberId: string): Promise<Result> {
  const r = await api.DELETE("/api/splits/{group_id}/members/{member_id}", {
    params: { path: { group_id: groupId, member_id: memberId } },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

export async function setGuestsCanAdd(groupId: string, on: boolean): Promise<Result> {
  const r = await api.PATCH("/api/splits/{group_id}", {
    params: { path: { group_id: groupId } },
    body: { guests_can_add: on },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

export async function sendInvite(
  groupId: string,
  email: string,
  emailAgain: string | null,
): Promise<{ ok: true; id: string; token: string } | { ok: false; code: string }> {
  const r = await api.POST("/api/splits/{group_id}/invites", {
    params: { path: { group_id: groupId } },
    body: { email, ...(emailAgain === null ? {} : { email_again: emailAgain }) },
  });
  const failure = failureOf(r);
  if (failure || !r.data) return { ok: false, code: codeOf(failure) };
  return { ok: true, id: r.data.id, token: r.data.token };
}

/**
 * The same invite again (November 11, 2026): a new link, the same 7 days, once a day. The
 * address goes with it because the server keeps only its hash and checks it matches.
 */
export async function remindInvite(
  groupId: string,
  inviteId: string,
  email: string,
): Promise<Result> {
  const r = await api.POST("/api/splits/{group_id}/invites/{invite_id}/remind", {
    params: { path: { group_id: groupId, invite_id: inviteId } },
    body: { email },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

export async function cancelInvite(groupId: string, inviteId: string): Promise<Result> {
  const r = await api.DELETE("/api/splits/{group_id}/invites/{invite_id}", {
    params: { path: { group_id: groupId, invite_id: inviteId } },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

export async function disputeBill(groupId: string, billId: string): Promise<Result> {
  const r = await api.POST("/api/splits/{group_id}/disputes", {
    params: { path: { group_id: groupId } },
    body: { bill_id: billId },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

/** The organizer closes every dispute on a bill once fixed; a disputer withdraws their own. */
export async function closeDispute(groupId: string, billId: string): Promise<Result> {
  const r = await api.POST("/api/splits/{group_id}/disputes/{bill_id}/close", {
    params: { path: { group_id: groupId, bill_id: billId } },
  });
  const failure = failureOf(r);
  return failure ? fail(codeOf(failure)) : OK;
}

export type ReportReason = "dont_know" | "not_owed" | "pushy" | "other";

export const REPORT_REASONS: ReadonlyArray<readonly [ReportReason, string]> = [
  ["dont_know", "I don't know them"],
  ["not_owed", "Asked for money I don't owe"],
  ["pushy", "Pushy or threatening"],
  ["other", "Something else"],
];

/** Leave; "Report and leave" adds one report against the organizer (spec "Reports and blocks"). */
export async function leaveGroup(
  db: StackdDb,
  groupId: string,
  report: ReportReason | null,
): Promise<Result> {
  const r = await api.POST("/api/splits/{group_id}/leave", {
    params: { path: { group_id: groupId } },
    body: report ? { report } : {},
  });
  const failure = failureOf(r);
  if (failure) return fail(codeOf(failure));
  await forgetGroupBlobs(db, groupId);
  return OK;
}

/** Plain words for the server's and the rule's codes. */
export function splitErrorText(code: string): string {
  const words: Record<string, string> = {
    daily_limit: "Done for today. More tomorrow at midnight.",
    invite_limit: "That's today's invites. More tomorrow at midnight.",
    plan_limit: "This group is full for your plan.",
    plan_required: "Groups need Private or Connected.",
    split_blocked: "Reports have paused your groups. Support can look at it.",
    read_only: "This group is view and settle only right now.",
    guests_cannot_add: "The organizer has turned off adding bills.",
    emails_differ: "The two emails don't match.",
    own_email: "That's your own email.",
    declined_before: "They said they don't know you. You can't invite that email again.",
    already_member: "They're already in this group.",
    parts_do_not_add_up: "The amounts don't add up to the bill.",
    percent_must_sum_to_10000: "The percents need to add up to 100.",
    no_people: "Pick at least one person.",
    item_no_people: "Tick who had each item.",
    no_items: "Add an item.",
    invalid_extras: "Tax, tip and fees can't be below $0.",
    invalid_amount: "Enter an amount above $0.",
    already_invited: "They already have an invite waiting. Remind them from Invites waiting.",
    remind_tomorrow: "Already sent today. You can remind them again tomorrow.",
    not_this_invite: "That isn't the email this invite went to.",
    invalid_share: "Each share needs a whole number above 0.",
    values_must_match_people: "Fill in everyone who's in.",
    not_saved: "Couldn't save. Try again when you're online.",
    organizer_active: "Someone already runs this group.",
    undo_closed: "That payment can't be undone any more.",
    too_many_groups: "That's 20 groups at once. Leave one to start or join another.",
    too_many_dates: "That first date is too far back for a repeating bill. Pick a later one.",
    warning_changed: "The warning changed. Close this and open it again.",
    other_email: "This invite is for a different email. Sign in with the address it was sent to.",
    not_found: "This invite has expired or was already used. Ask for a new one.",
    offline: "You're offline. Try again when connected.",
  };
  return words[code] ?? "Something went wrong. Try again.";
}
