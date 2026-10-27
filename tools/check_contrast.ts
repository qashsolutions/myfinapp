/**
 * WCAG AA contrast over every look x mode in packages/tokens/tokens.json.
 * Theme rule 5 (docs/spec.md): body text >= 4.5:1, large text >= 3:1, all six combinations.
 * Prints every pair; exits 1 if any is below its minimum.
 *
 * Usage: pnpm tsx tools/check_contrast.ts
 */

import { contrastPairs, contrastRatio } from "../packages/tokens/src/contrast";

const pairs = contrastPairs();
let failures = 0;
let current = "";
for (const p of pairs) {
  const combo = `${p.look} / ${p.mode}`;
  if (combo !== current) {
    current = combo;
    console.log(`\n${combo}`);
  }
  const ratio = contrastRatio(p.fg, p.bg);
  const ok = ratio >= p.min;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${ratio.toFixed(2).padStart(5)}:1  ${p.label.padEnd(28)} ${p.fg} on ${p.bg}  (min ${p.min})`,
  );
}
console.log(`\ncontrast: ${pairs.length - failures}/${pairs.length} pairs pass`);
process.exit(failures ? 1 : 0);
