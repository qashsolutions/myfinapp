// @vitest-environment node
/**
 * Tesseract.js reads a receipt image for real, with the model pinned in package.json loaded
 * from node_modules (the browser serves the same files from public/ocr). No network.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  OCR_ENGINE_VERSION,
  readReceiptText,
  stopOcr,
} from "../../src/features/receipts/ocr/engine.ts";
import { parseReceiptText } from "../../src/features/receipts/ocr/parse.ts";

const require = createRequire(import.meta.url);
const langPath = dirname(
  require.resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"),
);
const photo = readFileSync(new URL("../fixtures/receipt.png", import.meta.url));

afterAll(async () => {
  await stopOcr();
});

it("reads the merchant, date and total off a receipt photo on the device", async () => {
  const { text, engine_version } = await readReceiptText(photo, { langPath });
  expect(engine_version).toBe(OCR_ENGINE_VERSION);
  expect(text).toContain("TOTAL");
  expect(parseReceiptText(text, "2026-10-10")).toEqual({
    merchant: "Corner Market",
    date: "2026-10-09",
    total: "11.91",
    total_from: "total_line",
  });
}, 120_000);
