/**
 * Split bills on this device (chunk S.3a; spec "Split bills"; invariants 77–78).
 *
 * A group's key is made on the organizer's device and kept here only (`settings` `split.key.<id>`,
 * never synced or backed up). It reaches another device either in the QR code's `#k=` fragment
 * or wrapped to that device's own public key by a member's device that holds it: the device
 * posts a P-256 public key; a member's device derives a one-off key with an ephemeral P-256 pair
 * (ECDH, HKDF-SHA256) and wraps the group key under it. The server only ever holds opaque bytes.
 *
 * Every blob is AES-256-GCM under the group key with `stackd-split:<group>:<kind>:<member>` as
 * associated data, so a blob can't be moved to another member's name. Nothing here sends an
 * amount, a name or a group's name in the clear.
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
import type { StackdDb } from "../../data/db.ts";
import {
  type SplitPart,
  splitBalances,
  splitRepeatDates,
  splitSimplify,
} from "../../engine/bridge.ts";
import {
  balanceFacts,
  emptyLedger,
  type LedgerBlob,
  type Merged,
  merge,
  type ProfileBlob,
  parseLedger,
  parseProfile,
  peopleIn,
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

export const blobAad = (groupId: string, kind: "ledger" | "profile", memberId: string) =>
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

type State = {
  blobs: Array<{
    member_id: string;
    kind: string;
    ciphertext: string;
    version: number;
    updated_at: string;
  }>;
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

async function fetchState(groupId: string, background: boolean): Promise<State | null> {
  const r = await clientFor(background).GET("/api/splits/{group_id}/state", {
    params: { path: { group_id: groupId } },
  });
  if (failureOf(r) || !r.data) return null;
  return r.data as State;
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

async function readBlobs(
  key: Uint8Array,
  groupId: string,
  state: State,
): Promise<{
  ledgers: Map<string, LedgerBlob>;
  profiles: Map<string, ProfileBlob & { updated_at: string }>;
  versions: Map<string, number>;
}> {
  const ledgers = new Map<string, LedgerBlob>();
  const profiles = new Map<string, ProfileBlob & { updated_at: string }>();
  const versions = new Map<string, number>();
  for (const b of state.blobs) {
    if (b.kind !== "ledger" && b.kind !== "profile") continue;
    versions.set(`${b.kind}:${b.member_id}`, b.version);
    try {
      const value = await decryptJson<unknown>(
        key,
        fromBase64url(b.ciphertext),
        blobAad(groupId, b.kind, b.member_id),
      );
      if (b.kind === "ledger") {
        const ledger = parseLedger(value);
        if (ledger) ledgers.set(b.member_id, ledger);
      } else {
        const profile = parseProfile(value);
        if (profile) profiles.set(b.member_id, { ...profile, updated_at: b.updated_at });
      }
    } catch {
      // A blob this key can't open (moved, or written under another key) is left out.
    }
  }
  return { ledgers, profiles, versions };
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
    const candidates = [...ledger.bills, ...Object.values(ledger.edits)];
    for (const b of candidates) {
      if (b?.repeat && approved.has(b.id) && !repeats.has(repeatKey(b)))
        repeats.set(repeatKey(b), await splitRepeatDates(b.date, b.repeat, asOf));
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
  const state = await fetchState(groupId, background);
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

/**
 * Change my own ledger: read the server's copy (another device of mine may have written it),
 * apply the change, and write it back one version on. 409 means another write came first:
 * read again and retry once.
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
    const state = await fetchState(groupId, false);
    if (!state) return false;
    const { ledgers, versions } = await readBlobs(key, groupId, state);
    const next = change(ledgers.get(myMemberId) ?? emptyLedger());
    const version = (versions.get(`ledger:${myMemberId}`) ?? 0) + 1;
    const sealed = await encryptJson(key, next, blobAad(groupId, "ledger", myMemberId));
    const r = await clientFor(false).PUT("/api/splits/{group_id}/blobs/ledger", {
      params: { path: { group_id: groupId } },
      body: { ciphertext: toBase64url(sealed), version },
    });
    if (!failureOf(r)) return true;
    if (r.response.status !== 409) return false;
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
    const state = await fetchState(groupId, false);
    if (!state) return "failed";
    const { profiles, versions } = await readBlobs(key, groupId, state);
    const next = change(profiles.get(myMemberId) ?? null);
    const version = (versions.get(`profile:${myMemberId}`) ?? 0) + 1;
    const sealed = await encryptJson(key, next, blobAad(groupId, "profile", myMemberId));
    const r = await clientFor(false).PUT("/api/splits/{group_id}/blobs/profile", {
      params: { path: { group_id: groupId } },
      body: { ciphertext: toBase64url(sealed), version },
    });
    if (!failureOf(r)) return "ok";
    if (r.response.status !== 409) return "failed";
  }
  return "failed";
}

/** The QR code's link for an invite: the token and the key ride in the fragment only. */
export function inPersonLink(token: string, keyB64: string): string {
  return `${globalThis.location?.origin ?? ""}/splits/join#t=${token}&k=${keyB64}`;
}
