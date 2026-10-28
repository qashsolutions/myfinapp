import "./receipts.css";

import { Button, Card } from "@stackd/ui";
import { type ChangeEvent, useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import {
  ReceiptError,
  removeReceiptPhoto,
  retentionLabel,
  storeReceiptPhoto,
} from "../../data/receipts.ts";
import { formatDay, todayIso } from "../../lib/format.ts";
import { nativeCameraAvailable, takeReceiptPhoto } from "../../native/camera.ts";
import { OcrError, readReceiptText } from "./ocr/engine.ts";
import { parseReceiptText, type ReceiptSuggestion } from "./ocr/parse.ts";
import { useObjectUrl, useReceipt, useRetention } from "./useReceipts.ts";

/**
 * The receipt photo card inside Add entry (mockup F5Receipt): attach from the camera or the
 * photo library, see it, remove it. The photo never leaves the device. "Read text from photo"
 * (fast-follow 6) runs OCR on this device and suggests the merchant, date and total, which the
 * user checks before "Use these" fills the form; the text is kept on the receipt row.
 */
export function ReceiptCard({
  receiptId,
  onChange,
  onSuggest,
}: {
  receiptId: string | null;
  onChange: (receiptId: string | null) => void;
  onSuggest?: (suggestion: ReceiptSuggestion) => void;
}) {
  const { db } = useDb();
  const ids = useId();
  const retention = useRetention();
  const view = useReceipt(receiptId);
  const url = useObjectUrl(view?.file?.blob);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [suggestion, setSuggestion] = useState<ReceiptSuggestion | null>(null);
  const keptLine =
    retention === "forever"
      ? "Kept on this device until you remove it"
      : `Kept on this device for ${retentionLabel(retention).toLowerCase()}`;

  async function attachFile(file: File) {
    setError(null);
    setSuggestion(null);
    setBusy(true);
    try {
      const receipt = await storeReceiptPhoto(db, file, retention, todayIso());
      onChange(receipt.id);
    } catch (err) {
      setError(
        err instanceof ReceiptError && err.code === "unsupported"
          ? "Couldn't read that photo here. A JPEG or PNG works everywhere."
          : "That file doesn't look like a photo.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function attach(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await attachFile(file);
  }

  /** Inside a shell (chunk 2.3): the OS camera or library, same stripMetadata path after. */
  async function attachFromCamera() {
    const file = await takeReceiptPhoto();
    if (file) await attachFile(file);
  }

  async function remove() {
    if (!receiptId) return;
    await removeReceiptPhoto(db, receiptId);
    setSuggestion(null);
    onChange(null);
  }

  async function readText() {
    const blob = view?.file?.blob;
    if (!receiptId || !blob) return;
    setError(null);
    setReading(true);
    try {
      const { text, engine_version } = await readReceiptText(blob);
      await db.receipts.update(receiptId, {
        ocr_text: text,
        ocr_engine_version: engine_version,
        updated_at: new Date().toISOString(),
      });
      setSuggestion(parseReceiptText(text, todayIso()));
    } catch (err) {
      setError(
        err instanceof OcrError && err.code === "no_text"
          ? "Couldn't find any text in that photo. A sharper, straight-on shot helps."
          : "Couldn't read the photo here. You can type the amount instead.",
      );
    } finally {
      setReading(false);
    }
  }

  const picker = nativeCameraAvailable() ? (
    <Button size="sm" variant="secondary" disabled={busy} onClick={attachFromCamera}>
      {receiptId ? "Replace photo" : "Add a receipt photo"}
    </Button>
  ) : (
    <>
      <input
        id={`${ids}-file`}
        className="receipt-card__file"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={attach}
        disabled={busy}
      />
      <label htmlFor={`${ids}-file`} className="sk-btn sk-btn--secondary sk-btn--sm">
        {receiptId ? "Replace photo" : "Add a receipt photo"}
      </label>
    </>
  );

  if (!receiptId || !view?.receipt) {
    return (
      <Card as="section" aria-label="Receipt photo" className="receipt-card">
        <span className="receipt-card__thumb" aria-hidden="true">
          🧾
        </span>
        <div>
          <p className="receipt-card__title">Receipt photo</p>
          <p className="receipt-card__sub">
            {keptLine}. Location and camera data are removed first.
          </p>
          <div className="receipt-card__actions">{picker}</div>
          {error ? (
            <p className="auth__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </Card>
    );
  }

  const photoGone = view.receipt.file_id === null;
  const found = suggestion
    ? [
        suggestion.merchant ? `Merchant: ${suggestion.merchant}` : null,
        suggestion.date ? `Date: ${formatDay(suggestion.date)}` : null,
        suggestion.total
          ? `Total: $${suggestion.total}${suggestion.total_from === "largest" ? " (the largest amount; no total line found)" : ""}`
          : null,
      ].filter((s): s is string => s !== null)
    : [];
  return (
    <Card as="section" aria-label="Receipt photo" className="receipt-card">
      {url ? (
        <img className="receipt-card__thumb" src={url} alt="Receipt" />
      ) : (
        <span className="receipt-card__thumb" aria-hidden="true">
          🧾
        </span>
      )}
      <div>
        <p className="receipt-card__title">
          {photoGone ? "Photo removed" : "Receipt photo attached"}
        </p>
        <p className="receipt-card__sub">
          {photoGone
            ? `Removed after ${retention === "forever" ? "you asked" : retentionLabel(retention).toLowerCase()}${view.receipt.purged_at ? ` on ${formatDay(view.receipt.purged_at.slice(0, 10))}` : ""}. The entry stays.`
            : view.receipt.purge_after
              ? `${keptLine} · until ${formatDay(view.receipt.purge_after)}`
              : keptLine}
        </p>
        <div className="receipt-card__actions">
          {!photoGone ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={reading || !view.file}
              onClick={readText}
              title="Reads the text on this device; nothing is uploaded"
            >
              {reading ? "Reading…" : "Read text from photo"}
            </Button>
          ) : null}
          {picker}
          {!photoGone ? (
            <Button size="sm" variant="ghost" onClick={remove}>
              Remove photo
            </Button>
          ) : null}
        </div>
        {suggestion ? (
          <fieldset className="receipt-card__suggest" aria-label="Read from the photo">
            {found.length > 0 ? (
              <>
                <p className="receipt-card__sub">
                  <strong>From the photo, to check:</strong>
                </p>
                <ul className="receipt-card__found">
                  {found.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <div className="receipt-card__actions">
                  <Button
                    size="sm"
                    onClick={() => {
                      onSuggest?.(suggestion);
                      setSuggestion(null);
                    }}
                  >
                    Use these
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
                    Not now
                  </Button>
                </div>
              </>
            ) : (
              <p className="receipt-card__sub" role="status">
                No merchant, date or total found in the text. You can type the amount.
              </p>
            )}
          </fieldset>
        ) : null}
        {error ? (
          <p className="auth__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
