/**
 * Split bills on this device (chunk S.3a; spec "Split bills"; invariants 77–78).
 *
 * A group's key is made on the organizer's device and kept in `settings` `split.key.<id>`, which
 * travels in the person's encrypted backup and never in the export (owner decision, November 9,
 * 2026), so a lost device never loses a group. It reaches another member's device either in the QR code's `#k=` fragment
 * or wrapped to that device's own public key by a member's device that holds it: the device
 * posts a P-256 public key; a member's device derives a one-off key with an ephemeral P-256 pair
 * (ECDH, HKDF-SHA256) and wraps the group key under it. The server only ever holds opaque bytes.
 *
 * Every blob is AES-256-GCM under the group key with `stackd-split:<group>:<kind>:<member>` as
 * associated data, so a blob can't be moved to another member's name. Nothing here sends an
 * amount, a name or a group's name in the clear.
 *
 * A member's ledger is a head and one page a month (chunk S.5; `ledger.ts`). This device keeps
 * the blobs it has seen (`split_blobs`, ciphertext) and asks the server only for what changed.
 */

import { clientFor, failureOf } from "../../data/api.ts";
import {
  CryptoError,
  decrypt,
  decryptJson,
  deriveWrappingKey,
  encrypt,
  encryptJson,
  fromBase64url,
  randomBytes,
  toBase64url,
} from "../../data/backup/crypto.ts";
import type { SplitBlobCache, StackdDb } from "../../data/db.ts";
import {
  type SplitPart,
  splitBalances,
  splitRepeatDates,
  splitSimplify,
} from "../../engine/bridge.ts";
import { todayIso } from "../../lib/format.ts";
import { compareText } from "../../lib/order.ts";
import {
  balanceFacts,
  canonical,
  combinePages,
  decodePage,
  encodePage,
  type HeadBlob,
  isValidBill,
  type LedgerBlob,
  type LedgerPage,
  type Merged,
  merge,
  PAGE_FORMAT,
  type ProfileBlob,
  pageMonth,
  parseHead,
  parseProfile,
  peopleIn,
  placeOnPages,
} from "./ledger.ts";

const KEY_PREFIX = "split.key.";
const DEVICE_SETTING = "split.device";
const WRAP_INFO = "stackd-split-key-v1";

export interface SplitMemberInfo {
  member_id: string;
  display_name: string;
  initial: string;
  is_me: boolean;
  is_organizer: boolean;
  guest: boolean;
}

export interface SplitView {
  groupId: string;
  /** False until this device holds the group's key (it asked a member's device for it). */
  hasKey: boolean;
  merged: Merged;
  profiles: Map<string, ProfileBlob & { updated_at: string }>;
  balances: SplitPart[];
  onHold: string[];
  payments: Array<{ from: string; to: string; cents: number }>;
  /** Open disputes: which bill, and the member who raised it. */
  disputes: Array<{ bill_id: string; member_id: string | null }>;
  writable: boolean;
}

async function setting<T>(db: StackdDb, key: string): Promise<T | undefined> {
  return (await db.settings.get(key))?.value as T | undefined;
}

async function putSetting(db: StackdDb, key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value, updated_at: new Date().toISOString() });
}

/** `kind` is `ledger` (the head), `ledger:YYYY-MM` (a page) or `profile`. */
export const blobAad = (groupId: string, kind: string, memberId: string) =>
  `stackd-split:${groupId}:${kind}:${memberId}`;
const keyAad = (groupId: string, memberId: string, deviceKeyId: string) =>
  `stackd-split-key:${groupId}:${memberId}:${deviceKeyId}`;

export async function groupKey(db: StackdDb, groupId: string): Promise<Uint8Array | null> {
  const text = await setting<string>(db, KEY_PREFIX + groupId);
  return text ? fromBase64url(text) : null;
}

export async function rememberGroupKey(db: StackdDb, groupId: string, keyB64: string) {
  if (fromBase64url(keyB64).length !== 32) throw new CryptoError("wrong_key", "Not a group key.");
  await putSetting(db, KEY_PREFIX + groupId, keyB64);
}

/** The organizer's device makes a group's key once, when the group starts. */
export async function newGroupKey(db: StackdDb, groupId: string): Promise<string> {
  const key = toBase64url(randomBytes(32));
  await rememberGroupKey(db, groupId, key);
  return key;
}

// ---- this device's key pair for handovers ----

interface DeviceKeys {
  id: string;
  private_jwk: JsonWebKey;
  public_raw: string;
}

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;

async function deviceKeys(db: StackdDb): Promise<DeviceKeys> {
  const saved = await setting<DeviceKeys>(db, DEVICE_SETTING);
  if (saved) return saved;
  const pair = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const keys: DeviceKeys = {
    id: toBase64url(randomBytes(12)),
    private_jwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    public_raw: toBase64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  };
  await putSetting(db, DEVICE_SETTING, keys);
  return keys;
}

async function sharedSecret(privateKey: CryptoKey, publicRaw: Uint8Array): Promise<Uint8Array> {
  const pub = await crypto.subtle.importKey("raw", publicRaw as BufferSource, P256, false, []);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256),
  );
}

/** ephemeral public key (65 bytes) ‖ the group key under ECDH + HKDF. */
export async function wrapForDevice(
  groupKeyBytes: Uint8Array,
  devicePublicRaw: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const eph = (await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair;
  const ephPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const kek = await deriveWrappingKey(
    await sharedSecret(eph.privateKey, devicePublicRaw),
    ephPublic,
    WRAP_INFO,
  );
  const sealed = await encrypt(kek, groupKeyBytes, aad);
  const out = new Uint8Array(ephPublic.length + sealed.length);
  out.set(ephPublic, 0);
  out.set(sealed, ephPublic.length);
  return out;
}

export async function unwrapOnDevice(
  privateJwk: JsonWebKey,
  wrapped: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const ephPublic = wrapped.subarray(0, 65);
  const priv = await crypto.subtle.importKey("jwk", privateJwk, P256, false, ["deriveBits"]);
  const kek = await deriveWrappingKey(await sharedSecret(priv, ephPublic), ephPublic, WRAP_INFO);
  const key = await decrypt(kek, wrapped.subarray(65), aad);
  if (key.length !== 32) throw new CryptoError("wrong_key", "Not a group key.");
  return key;
}

// ---- server calls ----

type Blob = {
  member_id: string;
  kind: string;
  ciphertext: string;
  version: number;
  updated_at: string;
};

type State = {
  blobs: Blob[];
  bill_ids: string[];
  pending: Array<{ bill_id: string; member_id: string | null }>;
  disputes: Array<{ bill_id: string; member_id: string | null }>;
  keys: Array<{
    member_id: string;
    device_key_id: string;
    public_key: string;
    wrapped_key: string | null;
  }>;
  writable: boolean;
};

const cacheId = (groupId: string, memberId: string, kind: string) =>
  `${groupId}/${memberId}/${kind}`;

async function remember(db: StackdDb, groupId: string, b: Blob): Promise<void> {
  const row: SplitBlobCache = {
    id: cacheId(groupId, b.member_id, b.kind),
    group_id: groupId,
    ...b,
  };
  await db.split_blobs.put(row);
}

/** This device's copies of a group's blobs, dropped when it leaves or is removed. */
export async function forgetGroupBlobs(db: StackdDb, groupId: string): Promise<void> {
  await db.split_blobs.where("group_id").equals(groupId).delete();
}

/**
 * The group's state with every blob: the server sends only the ones this device lacks at their
 * version (chunk S.5), the rest come from `split_blobs`.
 */
async function fetchState(
  db: StackdDb,
  groupId: string,
  background: boolean,
): Promise<State | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const held =
      attempt === 0 ? await db.split_blobs.where("group_id").equals(groupId).toArray() : [];
    const known = Object.fromEntries(held.map((c) => [`${c.member_id}/${c.kind}`, c.version]));
    const r = await clientFor(background).POST("/api/splits/{group_id}/state", {
      params: { path: { group_id: groupId } },
      body: { known },
    });
    const failure = failureOf(r);
    if (failure?.status === 404) await forgetGroupBlobs(db, groupId);
    if (failure || !r.data) return null;
    const data = r.data as State & {
      versions: Array<{ member_id: string; kind: string; version: number }>;
    };
    const fresh = new Map(data.blobs.map((b) => [`${b.member_id}/${b.kind}`, b]));
    const cached = new Map(held.map((c) => [`${c.member_id}/${c.kind}`, c]));
    for (const b of data.blobs) await remember(db, groupId, b);
    const blobs: Blob[] = [];
    let missing = false;
    for (const v of data.versions) {
      const id = `${v.member_id}/${v.kind}`;
      const b = fresh.get(id) ?? cached.get(id);
      if (b && b.version === v.version) blobs.push(b);
      else missing = true;
    }
    const live = new Set(data.versions.map((v) => cacheId(groupId, v.member_id, v.kind)));
    const gone = held.filter((c) => !live.has(c.id)).map((c) => c.id);
    if (gone.length) await db.split_blobs.bulkDelete(gone);
    // A copy went missing between the read and the answer: ask once more for everything.
    if (!missing) return { ...data, blobs };
  }
  return null;
}

/**
 * Hand the key over: unwrap ours if a member's device wrapped it, ask for it if we don't hold
 * it, and wrap it for every member device still waiting. True when this device holds the key.
 */
async function handOver(
  db: StackdDb,
  groupId: string,
  myMemberId: string,
  state: State,
  background: boolean,
): Promise<boolean> {
  const device = await deviceKeys(db);
  let key = await groupKey(db, groupId);
  if (!key) {
    const mine = state.keys.find(
      (k) => k.member_id === myMemberId && k.device_key_id === device.id && k.wrapped_key,
    );
    if (mine?.wrapped_key) {
      try {
        key = await unwrapOnDevice(
          device.private_jwk,
          fromBase64url(mine.wrapped_key),
          keyAad(groupId, myMemberId, device.id),
        );
        await rememberGroupKey(db, groupId, toBase64url(key));
      } catch {
        key = null;
      }
    }
    if (
      !key &&
      !state.keys.some((k) => k.member_id === myMemberId && k.device_key_id === device.id)
    ) {
      await clientFor(background).PUT("/api/splits/{group_id}/keys/request", {
        params: { path: { group_id: groupId } },
        body: { device_key_id: device.id, public_key: device.public_raw },
      });
    }
  }
  if (!key) return false;
  for (const k of state.keys) {
    if (k.wrapped_key || (k.member_id === myMemberId && k.device_key_id === device.id)) continue;
    const wrapped = await wrapForDevice(
      key,
      fromBase64url(k.public_key),
      keyAad(groupId, k.member_id, k.device_key_id),
    );
    await clientFor(background).PUT("/api/splits/{group_id}/keys/{member_id}/{device_key_id}", {
      params: {
        path: { group_id: groupId, member_id: k.member_id, device_key_id: k.device_key_id },
      },
      body: { wrapped_key: toBase64url(wrapped) },
    });
  }
  return true;
}

interface MemberLedger {
  head: HeadBlob | null;
  pages: Map<string, LedgerPage>;
}

async function readBlobs(
  key: Uint8Array,
  groupId: string,
  state: Pick<State, "blobs">,
): Promise<{
  ledgers: Map<string, LedgerBlob>;
  raw: Map<string, MemberLedger>;
  profiles: Map<string, ProfileBlob & { updated_at: string }>;
  versions: Map<string, number>;
}> {
  const raw = new Map<string, MemberLedger>();
  const profiles = new Map<string, ProfileBlob & { updated_at: string }>();
  const versions = new Map<string, number>();
  const ledgerOf = (member: string): MemberLedger => {
    let l = raw.get(member);
    if (!l) {
      l = { head: null, pages: new Map() };
      raw.set(member, l);
    }
    return l;
  };
  for (const b of state.blobs) {
    const month = pageMonth(b.kind);
    if (b.kind !== "ledger" && b.kind !== "profile" && !month) continue;
    versions.set(`${b.member_id}/${b.kind}`, b.version);
    try {
      const value = await decryptJson<unknown>(
        key,
        fromBase64url(b.ciphertext),
        blobAad(groupId, b.kind, b.member_id),
      );
      if (month) {
        const page = decodePage(value, b.member_id);
        if (page) ledgerOf(b.member_id).pages.set(month, page);
      } else if (b.kind === "ledger") {
        ledgerOf(b.member_id).head = parseHead(value);
      } else {
        const profile = parseProfile(value);
        if (profile) profiles.set(b.member_id, { ...profile, updated_at: b.updated_at });
      }
    } catch {
      // A blob this key can't open (moved, or written under another key) is left out.
    }
  }
  const ledgers = new Map<string, LedgerBlob>();
  for (const [member, l] of raw) ledgers.set(member, combinePages(l.head, l.pages));
  return { ledgers, raw, profiles, versions };
}

/** A member's ledger as the blobs it is stored in (tests seed a fake server with these). */
export async function sealLedger(
  key: Uint8Array,
  groupId: string,
  memberId: string,
  ledger: LedgerBlob,
  month: string,
): Promise<Array<{ kind: string; ciphertext: string }>> {
  const pages = placeOnPages(new Map(), ledger, month);
  const out = [
    {
      kind: "ledger",
      ciphertext: toBase64url(
        await encryptJson(
          key,
          { v: PAGE_FORMAT, group: ledger.group } satisfies HeadBlob,
          blobAad(groupId, "ledger", memberId),
        ),
      ),
    },
  ];
  for (const [m, page] of pages) {
    const kind = `ledger:${m}`;
    out.push({
      kind,
      ciphertext: toBase64url(
        await encryptJson(key, encodePage(page), blobAad(groupId, kind, memberId)),
      ),
    });
  }
  return out;
}

/** A member's ledger read back from its blobs. */
export async function openLedger(
  key: Uint8Array,
  groupId: string,
  memberId: string,
  blobs: Array<{ member_id: string; kind: string; ciphertext: string }>,
): Promise<LedgerBlob | null> {
  const mine = blobs
    .filter((b) => b.member_id === memberId)
    .map((b) => ({ ...b, version: 1, updated_at: "" }));
  const { ledgers } = await readBlobs(key, groupId, { blobs: mine });
  return ledgers.get(memberId) ?? null;
}

export async function computeView(
  groupId: string,
  organizer: string | null,
  liveMembers: string[],
  ledgers: Map<string, LedgerBlob>,
  state: Pick<State, "bill_ids" | "pending" | "disputes" | "writable">,
  profiles: SplitView["profiles"],
  asOf: string,
): Promise<SplitView> {
  const approved = new Set(state.bill_ids);
  // Keyed by what decides the dates, so a bill and the organizer's edit of it never collide.
  const repeatKey = (b: { id: string; date: string; repeat: string | null }) =>
    `${b.id}|${b.date}|${b.repeat}`;
  const repeats = new Map<string, string[]>();
  for (const ledger of ledgers.values()) {
    const candidates = [
      ...(Array.isArray(ledger.bills) ? ledger.bills : []),
      ...Object.values(ledger.edits && typeof ledger.edits === "object" ? ledger.edits : {}),
      ...Object.values(
        ledger.approved && typeof ledger.approved === "object" ? ledger.approved : {},
      ),
    ];
    for (const b of candidates) {
      if (!isValidBill(b) || !b.repeat || !approved.has(b.id) || repeats.has(repeatKey(b)))
        continue;
      // A repeat with too many dates to add (a start years back) counts once instead of
      // stopping the whole group's view; the form refuses such a start.
      repeats.set(
        repeatKey(b),
        await splitRepeatDates(b.date, b.repeat, asOf).catch(() => [b.date]),
      );
    }
  }
  const merged = merge({
    organizer,
    ledgers,
    approved,
    pending: new Set(state.pending.map((p) => p.bill_id)),
    disputed: new Set(state.disputes.map((d) => d.bill_id)),
    repeatDates: (bill) => repeats.get(repeatKey(bill)) ?? [bill.date],
  });
  const people = peopleIn(liveMembers, merged);
  const facts = balanceFacts(merged);
  const { balances, on_hold } = await splitBalances(people, facts.bills, facts.settlements);
  const { payments } = await splitSimplify(balances);
  return {
    groupId,
    hasKey: true,
    merged,
    profiles,
    balances,
    onHold: on_hold,
    payments,
    disputes: state.disputes,
    writable: state.writable,
  };
}

/** Pull a group: hand the key over, open every blob, merge and balance. */
export async function pullGroup(
  db: StackdDb,
  groupId: string,
  me: { memberId: string; organizer: string | null; live: string[] },
  asOf: string,
  background = false,
): Promise<SplitView | null> {
  const state = await fetchState(db, groupId, background);
  if (!state) return null;
  const hasKey = await handOver(db, groupId, me.memberId, state, background);
  const key = hasKey ? await groupKey(db, groupId) : null;
  if (!key) {
    return {
      groupId,
      hasKey: false,
      merged: { group: null, bills: [], settlements: [], claims: [] },
      profiles: new Map(),
      balances: [],
      onHold: [],
      payments: [],
      disputes: [],
      writable: state.writable,
    };
  }
  const { ledgers, profiles } = await readBlobs(key, groupId, state);
  return computeView(groupId, me.organizer, me.live, ledgers, state, profiles, asOf);
}

/** Write one of my blobs one version on, and keep the copy. "stale" when another write won. */
async function writeBlob(
  db: StackdDb,
  key: Uint8Array,
  groupId: string,
  myMemberId: string,
  kind: string,
  value: unknown,
  version: number,
): Promise<"ok" | "stale" | "failed"> {
  const ciphertext = toBase64url(await encryptJson(key, value, blobAad(groupId, kind, myMemberId)));
  const month = pageMonth(kind);
  const r = month
    ? await clientFor(false).PUT("/api/splits/{group_id}/blobs/ledger/{page}", {
        params: { path: { group_id: groupId, page: month } },
        body: { ciphertext, version },
      })
    : await clientFor(false).PUT(
        kind === "profile"
          ? "/api/splits/{group_id}/blobs/profile"
          : "/api/splits/{group_id}/blobs/ledger",
        { params: { path: { group_id: groupId } }, body: { ciphertext, version } },
      );
  if (failureOf(r)) return r.response.status === 409 ? "stale" : "failed";
  await remember(db, groupId, {
    member_id: myMemberId,
    kind,
    ciphertext,
    version,
    updated_at: new Date().toISOString(),
  });
  return "ok";
}

/**
 * Change my own ledger: read the server's copy (another device of mine may have written it),
 * apply the change, and write back only the pages it touched, each one version on: a bill or a
 * settlement stays on the page it was recorded on, anything new goes on this month's (or my
 * newest) page, the group's settings on the head. 409 means another write came first: read
 * again and retry once (a bill or settlement written twice is kept once, by its id).
 */
export async function updateMyLedger(
  db: StackdDb,
  groupId: string,
  myMemberId: string,
  change: (ledger: LedgerBlob) => LedgerBlob,
): Promise<boolean> {
  const key = await groupKey(db, groupId);
  if (!key) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await fetchState(db, groupId, false);
    if (!state) return false;
    const { raw, versions } = await readBlobs(key, groupId, state);
    const mine = raw.get(myMemberId) ?? { head: null, pages: new Map<string, LedgerPage>() };
    const before = combinePages(mine.head, mine.pages);
    const next = change(before);
    const newest = [...mine.pages.keys()].sort(compareText).at(-1);
    const thisMonth = todayIso().slice(0, 7);
    const month = newest && compareText(newest, thisMonth) > 0 ? newest : thisMonth;
    const writes: Array<{ kind: string; value: unknown }> = [];
    if (canonical(next.group ?? null) !== canonical(before.group ?? null))
      writes.push({ kind: "ledger", value: { v: PAGE_FORMAT, group: next.group ?? null } });
    for (const [m, page] of placeOnPages(mine.pages, next, month)) {
      const old = mine.pages.get(m);
      const empty = !page.bills.length && !page.settlements.length;
      const nothing =
        empty && !Object.keys(page.edits).length && !Object.keys(page.approved).length;
      if (old ? canonical(encodePage(old)) === canonical(encodePage(page)) : nothing) continue;
      writes.push({ kind: `ledger:${m}`, value: encodePage(page) });
    }
    let stale = false;
    for (const w of writes) {
      const version = (versions.get(`${myMemberId}/${w.kind}`) ?? 0) + 1;
      const done = await writeBlob(db, key, groupId, myMemberId, w.kind, w.value, version);
      if (done === "failed") return false;
      if (done === "stale") {
        stale = true;
        break;
      }
    }
    if (!stale) return true;
  }
  return false;
}

/**
 * My payment handles and name in one group's encrypted profile (spec "Payment handles"): read
 * the server's copy, change it, write one version on (the route asks for a fresh passkey check,
 * which the caller gets first). Only I can write my profile; nobody else can change my handles.
 */
export async function updateMyProfile(
  db: StackdDb,
  groupId: string,
  myMemberId: string,
  change: (profile: ProfileBlob | null) => ProfileBlob,
): Promise<"ok" | "no_key" | "failed"> {
  const key = await groupKey(db, groupId);
  if (!key) return "no_key";
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await fetchState(db, groupId, false);
    if (!state) return "failed";
    const { profiles, versions } = await readBlobs(key, groupId, state);
    const next = change(profiles.get(myMemberId) ?? null);
    const version = (versions.get(`${myMemberId}/profile`) ?? 0) + 1;
    const done = await writeBlob(db, key, groupId, myMemberId, "profile", next, version);
    if (done !== "stale") return done;
  }
  return "failed";
}

/** The QR code's link for an invite: the token and the key ride in the fragment only. */
export function inPersonLink(token: string, keyB64: string): string {
  return `${globalThis.location?.origin ?? ""}/splits/join#t=${token}&k=${keyB64}`;
}
