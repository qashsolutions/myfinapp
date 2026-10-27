/**
 * The device-side cryptography for backups and household sharing (docs/spec.md "End-to-end
 * encrypted backup", "Couples & household"). WebCrypto only: AES-256-GCM for data, HKDF-SHA256
 * to turn a recovery key or a passkey PRF output into a key-wrapping key. Nothing here ever
 * talks to the network; the server only sees what `sync.ts` hands it, which is ciphertext.
 */

const VERSION = 1;
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** WebCrypto wants a plain ArrayBuffer view; copy the exact bytes of any typed array. */
function buf(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export class CryptoError extends Error {
  constructor(
    public readonly code: "bad_ciphertext" | "wrong_key" | "bad_recovery_key",
    message: string,
  ) {
    super(message);
    this.name = "CryptoError";
  }
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new CryptoError("bad_ciphertext", "Not base64url.");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(bytes)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function aesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(raw), "AES-GCM", false, usages);
}

/** version(1) || iv(12) || ciphertext+tag. `aad` binds the blob to its owner or household. */
export async function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv), additionalData: buf(encoder.encode(aad)) },
      await aesKey(key, ["encrypt"]),
      buf(plaintext),
    ),
  );
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

export async function decrypt(key: Uint8Array, blob: Uint8Array, aad: string): Promise<Uint8Array> {
  if (blob.length < 1 + IV_BYTES + 16 || blob[0] !== VERSION)
    throw new CryptoError("bad_ciphertext", "Not a Qash backup.");
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buf(blob.subarray(1, 1 + IV_BYTES)),
          additionalData: buf(encoder.encode(aad)),
        },
        await aesKey(key, ["decrypt"]),
        buf(blob.subarray(1 + IV_BYTES)),
      ),
    );
  } catch {
    throw new CryptoError("wrong_key", "The key doesn't open this backup.");
  }
}

export async function encryptJson(
  key: Uint8Array,
  value: unknown,
  aad: string,
): Promise<Uint8Array> {
  return encrypt(key, encoder.encode(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(key: Uint8Array, blob: Uint8Array, aad: string): Promise<T> {
  const text = decoder.decode(await decrypt(key, blob, aad));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CryptoError("bad_ciphertext", "The backup's contents are not readable.");
  }
}

/** HKDF-SHA256(secret, salt, info) → 32 bytes, the key that wraps the backup key. */
export async function deriveWrappingKey(
  secret: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", buf(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(encoder.encode(info)) },
      base,
      256,
    ),
  );
}

export const WRAP_INFO = "stackd-backup-kek-v1";

export async function wrapKey(
  wrapping: Uint8Array,
  key: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  return encrypt(wrapping, key, aad);
}

export async function unwrapKey(
  wrapping: Uint8Array,
  wrapped: Uint8Array,
  aad: string,
): Promise<Uint8Array> {
  const key = await decrypt(wrapping, wrapped, aad);
  if (key.length !== 32) throw new CryptoError("wrong_key", "The key doesn't open this backup.");
  return key;
}

// Recovery key: 20 random bytes as 32 characters of a 32-letter alphabet without 0/O/1/I,
// shown in eight groups of four ("K7QX-...") so it can be written on paper and read back.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const RECOVERY_BYTES = 20;

export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_BYTES) throw new CryptoError("bad_recovery_key", "Wrong length.");
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{1,4}/g)?.join("-") ?? out;
}

/** Accepts the key as shown, or typed without dashes, in either case, with O/0 and I/1 confusions. */
export function parseRecoveryKey(text: string): Uint8Array {
  const cleaned = text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/0/g, "O")
    .replace(/[1I]/g, "L")
    .replace(/O/g, "Q");
  // The alphabet has no O, 0, 1 or I: a typed O is read as Q and 1/I as L only when the
  // user wrote them for those letters' lookalikes; the length check and the key wrap's
  // authentication catch anything else.
  if (cleaned.length !== 32)
    throw new CryptoError("bad_recovery_key", "A recovery key has 32 characters.");
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new CryptoError("bad_recovery_key", `"${ch}" is not part of a recovery key.`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out.slice(0, RECOVERY_BYTES));
}
