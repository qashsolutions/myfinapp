/**
 * Renders the app icons from the Qash mark, "Rising Q" (owner, October 16, 2026): a white Q on
 * an indigo tile with three marigold bars rising inside it. Run `pnpm icons` after changing the
 * mark; the PNGs are committed. apps/mobile/scripts/assets.ts, src/app/layout/Logo.tsx and the
 * website's Logo.astro draw the same mark.
 *
 *   icon-512.png             512  "any": rounded square (22% radius), mark at 80%
 *   icon-512-maskable.png    512  full bleed, mark at 64% (inside the 80% safe zone)
 *   icon-192.png             192  as "any"
 *   apple-touch-icon-180.png 180  full bleed (iOS applies its own mask), mark at 80%
 *   favicon-32.png + favicon.svg  rounded square (22% radius), mark at 80%
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const INDIGO = "#4338FF";
const MARIGOLD = "#FFB020";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

/** The mark in a 100-unit box: the Q's ring and tail in white, the bars in marigold. */
const MARK =
  '<circle cx="46" cy="46" r="28" fill="none" stroke="#FFFFFF" stroke-width="10"/>' +
  `<rect x="27" y="42" width="6" height="8" rx="2" fill="${MARIGOLD}"/>` +
  `<rect x="35.5" y="37" width="6" height="13" rx="2" fill="${MARIGOLD}"/>` +
  `<rect x="44" y="32" width="6" height="18" rx="2" fill="${MARIGOLD}"/>` +
  '<line x1="56" y1="56" x2="78" y2="78" stroke="#FFFFFF" stroke-width="10" stroke-linecap="round"/>';

/** An indigo tile (rounded, or full bleed when the OS masks it) with the mark centred on it. */
function svg(size: number, radiusFraction: number, markFraction: number): string {
  const r = Math.round(size * radiusFraction);
  const m = size * markFraction;
  const offset = (size - m) / 2;
  const scale = m / 100;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${r}" fill="${INDIGO}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">${MARK}</g>` +
    "</svg>"
  );
}

async function png(name: string, size: number, radius: number, mark: number): Promise<void> {
  await sharp(Buffer.from(svg(size, radius, mark)))
    .png()
    .toFile(join(OUT, name));
  console.log(`${name}  ${size}x${size}`);
}

await mkdir(OUT, { recursive: true });
await png("icon-512.png", 512, 0.22, 0.8);
await png("icon-512-maskable.png", 512, 0, 0.64);
await png("icon-192.png", 192, 0.22, 0.8);
await png("apple-touch-icon-180.png", 180, 0, 0.8);
await png("favicon-32.png", 32, 0.22, 0.8);
await writeFile(join(OUT, "favicon.svg"), svg(32, 0.22, 0.8));
console.log("favicon.svg");
