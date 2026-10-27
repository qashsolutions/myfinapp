/** Writes dist/tokens.css (CSS custom properties) and dist/tokens.ts (precomputed data). */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { allThemes, cssText, LOOKS, MODES, tokens } from "./index";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
mkdirSync(dist, { recursive: true });

const css = cssText();
writeFileSync(join(dist, "tokens.css"), css);

const header =
  "// Generated from packages/tokens/tokens.json by src/build.ts. Do not edit by hand.\n";
const ts = [
  header,
  `export const themes = ${JSON.stringify(allThemes(), null, 2)} as const;\n`,
  `export const pwaManifest = ${JSON.stringify(tokens.pwa_manifest, null, 2)} as const;\n`,
  `export const plans = ${JSON.stringify(tokens.plans, null, 2)} as const;\n`,
  `export const availability = ${JSON.stringify(tokens.availability, null, 2)} as const;\n`,
].join("\n");
writeFileSync(join(dist, "tokens.ts"), ts);

console.log(
  `tokens: wrote dist/tokens.css (${css.length} bytes, ${LOOKS.length} looks x ${MODES.length} modes) and dist/tokens.ts`,
);
