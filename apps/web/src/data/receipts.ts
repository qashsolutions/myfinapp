/**
 * Receipt photos (docs/spec.md "Receipts"): kept on this device only, metadata stripped before
 * they are stored, removed after the retention period while the entry's amount stays.
 *
 * Stripping is done on the bytes for JPEG and PNG (the formats phones and scanners produce),
 * so nothing has to be decoded and the result is identical everywhere. Anything else is
 * re-encoded through a canvas, which drops every tag; where no canvas exists it is refused
 * rather than stored with its metadata.
 */

import { addDays, addMonths } from "../engine/bridge.ts";
import {
  newId,
  type Receipt,
  type ReceiptRetention,
  type StackdDb,
  type StoredFile,
} from "./db.ts";

export const RETENTION_KEY = "receipts.retention";
export const DEFAULT_RETENTION: ReceiptRetention = "90d";
/** The suggested choices; any number of days from 1 to `MAX_RETENTION_DAYS` is allowed too. */
export const RETENTION_LABELS: Record<"90d" | "1y" | "forever", string> = {
  "90d": "90 days",
  "1y": "1 year",
  forever: "Forever",
};
export const MAX_RETENTION_DAYS = 3650;

function ownDays(retention: string): number | null {
  const m = /^([0-9]{1,4})d$/.exec(retention);
  const n = m ? Number(m[1]) : null;
  return n !== null && n >= 1 && n <= MAX_RETENTION_DAYS ? n : null;
}

export function isRetention(value: unknown): value is ReceiptRetention {
  return typeof value === "string" && (value in RETENTION_LABELS || ownDays(value) !== null);
}

/** "90 days", "1 year", "Forever", or the person's own "45 days". */
export function retentionLabel(retention: ReceiptRetention): string {
  if (retention in RETENTION_LABELS)
    return RETENTION_LABELS[retention as keyof typeof RETENTION_LABELS];
  const n = ownDays(retention) ?? 90;
  return `${n} ${n === 1 ? "day" : "days"}`;
}

export class ReceiptError extends Error {
  constructor(public readonly code: "unsupported" | "unreadable") {
    super(code);
    this.name = "ReceiptError";
  }
}

/** Reads a Blob's bytes in every environment (jsdom's Blob has no .arrayBuffer()). */
export function readBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function")
    return blob.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const JPEG_SOI = [0xff, 0xd8];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** PNG chunks that carry metadata (EXIF, text, timestamps); image chunks are kept. */
const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

/** Drops every APPn segment except APP0 (JFIF) and APP14 (Adobe), and comments. */
export function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (!startsWith(bytes, JPEG_SOI)) throw new ReceiptError("unreadable");
  const out: Uint8Array[] = [new Uint8Array(JPEG_SOI)];
  let pos = 2;
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) throw new ReceiptError("unreadable");
    const marker = bytes[pos + 1] as number;
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === 0xda) {
      out.push(bytes.subarray(pos)); // scan data through EOI: nothing after it is metadata
      break;
    }
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(bytes.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 3 >= bytes.length) throw new ReceiptError("unreadable");
    const length = ((bytes[pos + 2] as number) << 8) | (bytes[pos + 3] as number);
    const end = pos + 2 + length;
    if (length < 2 || end > bytes.length) throw new ReceiptError("unreadable");
    const metadata = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (!metadata) out.push(bytes.subarray(pos, end));
    pos = end;
  }
  return concat(out);
}

/** Drops the eXIf, text and time chunks; keeps everything the decoder needs. */
export function stripPng(bytes: Uint8Array): Uint8Array {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new ReceiptError("unreadable");
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length =
      ((bytes[pos] as number) << 24) |
      ((bytes[pos + 1] as number) << 16) |
      ((bytes[pos + 2] as number) << 8) |
      (bytes[pos + 3] as number);
    const type = String.fromCharCode(
      bytes[pos + 4] as number,
      bytes[pos + 5] as number,
      bytes[pos + 6] as number,
      bytes[pos + 7] as number,
    );
    const end = pos + 12 + length;
    if (length < 0 || end > bytes.length) throw new ReceiptError("unreadable");
    if (!PNG_METADATA_CHUNKS.has(type)) out.push(bytes.subarray(pos, end));
    pos = end;
    if (type === "IEND") break;
  }
  return concat(out);
}

/** A standalone ArrayBuffer for Blob(): the stripped bytes always own their buffer. */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function reencode(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined")
    throw new ReceiptError("unsupported");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ReceiptError("unsupported");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ReceiptError("unsupported");
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new ReceiptError("unsupported"))),
      "image/jpeg",
      0.92,
    );
  });
}

/** The photo without its metadata: JPEG and PNG on the bytes, anything else re-encoded. */
export async function stripMetadata(file: Blob): Promise<Blob> {
  const bytes = await readBytes(file);
  if (startsWith(bytes, JPEG_SOI))
    return new Blob([toBuffer(stripJpeg(bytes))], { type: "image/jpeg" });
  if (startsWith(bytes, PNG_SIGNATURE))
    return new Blob([toBuffer(stripPng(bytes))], { type: "image/png" });
  return reencode(file);
}

export async function purgeDateFor(
  retention: ReceiptRetention,
  created: string,
): Promise<string | null> {
  if (retention === "forever") return null;
  if (retention === "1y") return addMonths(created, 12);
  return addDays(created, ownDays(retention) ?? 90);
}

/** Strips the photo, stores it, and opens a pending receipt for the entry being written. */
export async function storeReceiptPhoto(
  db: StackdDb,
  file: File,
  retention: ReceiptRetention,
  today: string,
  now: Date = new Date(),
): Promise<Receipt> {
  const clean = await stripMetadata(file);
  const stamp = now.toISOString();
  const stored: StoredFile = {
    id: newId(),
    kind: "receipt",
    import_id: null,
    name: file.name || "receipt",
    type: clean.type,
    size: clean.size,
    blob: clean,
    created_at: stamp,
  };
  const receipt: Receipt = {
    id: newId(),
    entry_id: null,
    file_id: stored.id,
    status: "pending",
    purge_after: await purgeDateFor(retention, today),
    purged_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
  await db.transaction("rw", db.files, db.receipts, async () => {
    await db.files.add(stored);
    await db.receipts.add(receipt);
  });
  return receipt;
}

export async function removeReceiptPhoto(db: StackdDb, receiptId: string): Promise<void> {
  const receipt = await db.receipts.get(receiptId);
  if (!receipt) return;
  await db.transaction("rw", db.files, db.receipts, async () => {
    if (receipt.file_id) await db.files.delete(receipt.file_id);
    await db.receipts.update(receiptId, {
      file_id: null,
      purged_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });
}

/** Removes photos past their date. The receipt row and the entry's amount stay. */
export async function purgeExpiredReceipts(db: StackdDb, today: string): Promise<number> {
  const due = await db.receipts
    .where("purge_after")
    .belowOrEqual(today)
    .filter((r) => r.file_id !== null)
    .toArray();
  for (const r of due) await removeReceiptPhoto(db, r.id);
  // A pending receipt nobody attached to an entry is noise: drop it after its date too.
  const orphans = await db.receipts
    .where("purge_after")
    .belowOrEqual(today)
    .filter((r) => r.entry_id === null && r.file_id === null)
    .primaryKeys();
  if (orphans.length) await db.receipts.bulkDelete(orphans);
  return due.length;
}

export async function getRetention(db: StackdDb): Promise<ReceiptRetention> {
  const row = await db.settings.get(RETENTION_KEY);
  return isRetention(row?.value) ? row.value : DEFAULT_RETENTION;
}

/** Saves the setting and re-dates every photo still on the device from its own creation date. */
export async function setRetention(
  db: StackdDb,
  retention: ReceiptRetention,
  today: string,
): Promise<void> {
  await db.settings.put({
    key: RETENTION_KEY,
    value: retention,
    updated_at: new Date().toISOString(),
  });
  const withPhoto = await db.receipts.filter((r) => r.file_id !== null).toArray();
  for (const r of withPhoto) {
    await db.receipts.update(r.id, {
      purge_after: await purgeDateFor(retention, r.created_at.slice(0, 10)),
      updated_at: new Date().toISOString(),
    });
  }
  await purgeExpiredReceipts(db, today);
}
