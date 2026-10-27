/**
 * Statement files and receipt photos the user keeps on the device (docs/spec.md "Statement
 * import": the file is parsed on the device and never uploaded; the user can keep a copy).
 */

import { newId, type StackdDb, type StoredFile } from "./db.ts";

export async function storeFile(
  db: StackdDb,
  file: File,
  kind: StoredFile["kind"],
  importId: string | null,
  now: Date = new Date(),
): Promise<StoredFile> {
  const row: StoredFile = {
    id: newId(),
    kind,
    import_id: importId,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    created_at: now.toISOString(),
  };
  await db.files.add(row);
  return row;
}

export async function deleteFile(db: StackdDb, id: string): Promise<void> {
  await db.files.delete(id);
  await db.statement_imports.where("file_key").equals(id).modify({ file_key: null });
}

/** Reads a File as text in every environment (jsdom's File has no .text()). */
export function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
