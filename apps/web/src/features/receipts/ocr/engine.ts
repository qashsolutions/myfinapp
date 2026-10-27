/**
 * Reads the text off a receipt photo on this device (fast-follow 6; docs/spec.md "Receipt text
 * reading (OCR) note"). Tesseract.js runs in a Web Worker from files the app serves itself
 * (`public/ocr`, copied at build time from the pinned packages by `scripts/ocr-assets.ts`):
 * no CDN, no upload, no call to any service. The English model is pinned in package.json, so
 * the result is the same for the same photo and engine version. The photo and its text never
 * leave the device.
 *
 * The spec's open question (is a trained OCR model allowed under the no-AI rule?) is still
 * open: if the answer is no, delete this folder and the button on the receipt card.
 */

import type { Worker as OcrWorker } from "tesseract.js";

export const OCR_ENGINE_VERSION =
  "tesseract.js 7.0.0 / tesseract.js-core 7.0.0 / eng 4.0.0_best_int";

export interface OcrOptions {
  /** Where the worker, the cores and `lang/eng.traineddata.gz` are served from. */
  workerPath?: string;
  corePath?: string;
  langPath?: string;
}

export class OcrError extends Error {
  constructor(public readonly code: "no_text" | "failed") {
    super(code);
    this.name = "OcrError";
  }
}

const inBrowser = typeof document !== "undefined";
let worker: Promise<OcrWorker> | null = null;

/** The exact core file for this CPU, so only one loader and its .wasm are fetched. */
async function pickCore(): Promise<string> {
  const { relaxedSimd, simd } = await import("wasm-feature-detect");
  if (await relaxedSimd()) return "/ocr/tesseract-core-relaxedsimd-lstm.js";
  if (await simd()) return "/ocr/tesseract-core-simd-lstm.js";
  return "/ocr/tesseract-core-lstm.js";
}

async function getWorker(options: OcrOptions): Promise<OcrWorker> {
  if (!worker) {
    worker = (async () => {
      const { createWorker, OEM } = await import("tesseract.js");
      return createWorker("eng", OEM.LSTM_ONLY, {
        ...(inBrowser ? { workerPath: "/ocr/worker.min.js", corePath: await pickCore() } : {}),
        langPath: options.langPath ?? "/ocr/lang",
        ...(options.workerPath ? { workerPath: options.workerPath } : {}),
        ...(options.corePath ? { corePath: options.corePath } : {}),
        workerBlobURL: false, // a plain worker URL keeps the .wasm next to its loader
        cacheMethod: "none", // nothing is tucked into IndexedDB; the browser's HTTP cache does
        gzip: true,
      });
    })();
    worker.catch(() => {
      worker = null;
    });
  }
  return worker;
}

export async function readReceiptText(
  image: Blob | Uint8Array | string,
  options: OcrOptions = {},
): Promise<{ text: string; engine_version: string }> {
  let text: string;
  try {
    const w = await getWorker(options);
    const result = await w.recognize(image as Parameters<OcrWorker["recognize"]>[0]);
    text = (result.data.text ?? "").trim();
  } catch (err) {
    if (err instanceof OcrError) throw err;
    throw new OcrError("failed");
  }
  if (!text) throw new OcrError("no_text");
  return { text, engine_version: OCR_ENGINE_VERSION };
}

/** Frees the worker (tests, or when the app wants the memory back). */
export async function stopOcr(): Promise<void> {
  if (!worker) return;
  const pending = worker;
  worker = null;
  try {
    await (await pending).terminate();
  } catch {
    // already gone
  }
}
