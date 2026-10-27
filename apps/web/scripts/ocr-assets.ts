/**
 * Copies the OCR runtime into public/ocr so the app serves it itself and never loads it from a
 * CDN: tesseract.js's worker, the three LSTM cores (plain, SIMD, relaxed SIMD: a loader and its
 * .wasm each) and the pinned English model. Run before `vite` by the dev and build scripts;
 * public/ocr is not committed. Sources come from the packages pinned in package.json.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "ocr");
const require = createRequire(import.meta.url);
const fromTesseract = createRequire(require.resolve("tesseract.js/package.json"));

const CORES = ["lstm", "simd-lstm", "relaxedsimd-lstm"];

export function ocrAssetSources(): Array<[string, string]> {
  const core = dirname(fromTesseract.resolve("tesseract.js-core/package.json"));
  const pairs: Array<[string, string]> = [
    [require.resolve("tesseract.js/dist/worker.min.js"), join(out, "worker.min.js")],
    [
      require.resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"),
      join(out, "lang", "eng.traineddata.gz"),
    ],
  ];
  for (const variant of CORES)
    for (const ext of [".js", ".wasm"])
      pairs.push([
        join(core, `tesseract-core-${variant}${ext}`),
        join(out, `tesseract-core-${variant}${ext}`),
      ]);
  return pairs;
}

export function copyOcrAssets(): { copied: number; kept: number } {
  let copied = 0;
  let kept = 0;
  for (const [src, dst] of ocrAssetSources()) {
    if (existsSync(dst) && statSync(dst).size === statSync(src).size) {
      kept += 1;
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied += 1;
  }
  return { copied, kept };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { copied, kept } = copyOcrAssets();
  console.log(`ocr assets: ${copied} copied, ${kept} already current (${out})`);
}
