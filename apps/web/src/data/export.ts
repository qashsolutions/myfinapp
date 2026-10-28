/**
 * "Download all my data" (docs/spec.md): a ZIP built on the device from the device database,
 * plus the one authenticated request that adds the server-held part (account, groups, plan).
 * Stored (uncompressed) ZIP entries with CRC-32, written here so the app needs no library.
 */

import type { ExportOut } from "./api.ts";
import type { StackdDb } from "./db.ts";
import { readBytes } from "./receipts.ts";

export interface ExportFile {
  name: string;
  data: Uint8Array;
}

const encoder = new TextEncoder();

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180: comma separated, CRLF line ends, quotes doubled. */
export function toCsv(rows: unknown[][]): string {
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function json(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** Integer cents as "12.34", with integer maths only (no float rounding near a cent). */
function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Everything the user owns, as files: the device tables plus the server's part. */
export async function collectExport(
  db: StackdDb,
  server: ExportOut | null,
  exportedAt: string,
): Promise<ExportFile[]> {
  const [
    accounts,
    categories,
    entries,
    goals,
    goalEvents,
    budgets,
    budgetLines,
    settings,
    merchantRules,
    recurring,
    debts,
    fund,
    receipts,
    anchors,
    imports,
    cards,
    worthItems,
    worthSnapshots,
    merchantNames,
  ] = await Promise.all([
    db.accounts.toArray(),
    db.categories.toArray(),
    db.entries.orderBy("date").toArray(),
    db.goals.toArray(),
    db.goal_events.toArray(),
    db.budgets.toArray(),
    db.budget_lines.toArray(),
    db.settings.toArray(),
    db.merchant_rules.toArray(),
    db.recurring_series.toArray(),
    db.debts.toArray(),
    db.emergency_fund.get("me"),
    db.receipts.toArray(),
    db.balance_anchors.toArray(),
    db.statement_imports.toArray(),
    db.card_details.toArray(),
    db.net_worth_items.toArray(),
    db.net_worth_snapshots.toArray(),
    db.merchant_names.toArray(),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const accountLabel = new Map(accounts.map((a) => [a.id, a.label]));
  const files: ExportFile[] = [
    {
      name: "profile.json",
      data: json({
        exported_at: exportedAt,
        app: "Qash",
        profile: server?.profile ?? null,
        plan: server?.plan ?? null,
        note: "Money data in this export came from your device; the server never had it.",
      }),
    },
    {
      name: "entries.csv",
      data: encoder.encode(
        toCsv([
          [
            "id",
            "date",
            "direction",
            "amount",
            "merchant",
            "category",
            "account",
            "source",
            "is_transfer",
            "is_recurring",
            "receipt_id",
            "tags",
            "note",
            "counted",
          ],
          ...entries.map((e) => [
            e.id,
            e.date,
            e.direction,
            dollars(e.amount_cents),
            e.merchant,
            e.category_id ? (categoryName.get(e.category_id) ?? e.category_id) : "",
            accountLabel.get(e.account_id) ?? e.account_id,
            e.source,
            e.is_transfer,
            e.is_recurring,
            e.receipt_id ?? "",
            (e.tags ?? []).join("; "),
            e.note ?? "",
            !e.not_counted,
          ]),
        ]),
      ),
    },
    { name: "goals.json", data: json({ goals, events: goalEvents }) },
    { name: "net_worth.json", data: json({ items: worthItems, monthly: worthSnapshots }) },
    {
      name: "groups.json",
      data: json({
        groups: server?.groups ?? [],
        my_targets: goals
          .filter((g) => g.group_id)
          .map((g) => ({ group_id: g.group_id, goal_id: g.id })),
      }),
    },
    {
      name: "budgets.json",
      data: json({
        budgets,
        lines: budgetLines,
        pay: settings.find((s) => s.key === "pay")?.value ?? null,
      }),
    },
    {
      name: "settings.json",
      data: json({
        settings,
        accounts,
        categories,
        merchant_rules: merchantRules,
        merchant_names: merchantNames,
        recurring_series: recurring,
        debts,
        emergency_fund: fund ?? null,
        balance_anchors: anchors,
        statement_imports: imports,
        card_details: cards,
        receipts,
      }),
    },
  ];
  for (const r of receipts) {
    if (!r.file_id) continue;
    const file = await db.files.get(r.file_id);
    if (!file || !(file.blob instanceof Blob)) continue;
    const ext = file.type === "image/png" ? "png" : "jpg";
    files.push({ name: `receipts/${r.id}.${ext}`, data: await readBytes(file.blob) });
  }
  return files;
}

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crcTable[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** DOS date and time fields for a UTC instant (ZIP has no zone; the export date is enough). */
function dosDateTime(at: Date): [number, number] {
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date =
    ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  return [time, date];
}

/** A ZIP with every entry stored as-is. Deterministic for the same files and date. */
export function zipStore(files: ExportFile[], at: Date): Uint8Array {
  const [time, date] = dosDateTime(at);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = encoder.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800), // UTF-8 names
      ...u16(0),
      ...u16(time),
      ...u16(date),
      ...u32(crc),
      ...u32(f.data.length),
      ...u32(f.data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    parts.push(local, f.data);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x0800),
        ...u16(0),
        ...u16(time),
        ...u16(date),
        ...u32(crc),
        ...u32(f.data.length),
        ...u32(f.data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ]),
    );
    offset += local.length + f.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);
  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** The names inside a ZIP written by zipStore (used by tests and the confirmation line). */
export function zipEntryNames(zip: Uint8Array): string[] {
  const names: string[] = [];
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let pos = 0;
  while (pos + 30 <= zip.length && view.getUint32(pos, true) === 0x04034b50) {
    const size = view.getUint32(pos + 18, true);
    const nameLength = view.getUint16(pos + 26, true);
    const extraLength = view.getUint16(pos + 28, true);
    names.push(new TextDecoder().decode(zip.subarray(pos + 30, pos + 30 + nameLength)));
    pos += 30 + nameLength + extraLength + size;
  }
  return names;
}

/** Hands the file to the browser; false where there is no download (tests, some webviews). */
export function downloadBytes(bytes: Uint8Array, filename: string): boolean {
  if (typeof URL.createObjectURL !== "function" || typeof document === "undefined") return false;
  try {
    const blob = new Blob(
      [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
      {
        type: "application/zip",
      },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    return false;
  }
}
