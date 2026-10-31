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
 *   logo.svg + logo.png      "QASH" alone in indigo, for light backgrounds
 *   logo-dark.png            "QASH" alone in white, for dark backgrounds
 *
 * The logo files are for outside use (partners, stores, print); the app never loads them, so
 * vite.config.ts keeps them out of the precache.
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

/**
 * "QASH" in Outfit 700 (SIL Open Font License, the app's own font) as outlines, so the logo
 * never depends on a font installed where it is rendered or viewed. Cap height is 100 units
 * from y = 0; the Q's tail drops below the baseline. Taken once from
 * @fontsource/outfit/files/outfit-latin-700-normal.woff with 4% tracking.
 */
const WORDMARK =
  "M57.37 101.7Q46.18 101.7 36.54 97.73Q26.91 93.77 19.76 86.69Q12.61 79.6 8.57 70.18Q4.53 60.76 4.53 49.86Q4.53 38.81 8.5 29.46Q12.46 20.11 19.62 13.1Q26.77 6.09 36.33 2.2Q45.89 -1.7 57.08 -1.7Q68.41 -1.7 77.97 2.2Q87.54 6.09 94.69 13.1Q101.84 20.11 105.81 29.53Q109.77 38.95 109.77 50Q109.77 60.91 105.81 70.25Q103.54 75.78 100.14 80.31L114.87 95.04L101.98 107.93L86.97 92.92Q82.86 95.75 78.05 97.73Q68.56 101.7 57.37 101.7ZM57.08 81.44Q65.58 81.44 71.95 77.9L55.24 61.19L68.13 48.3L84.14 64.31Q86.97 57.93 86.97 49.86Q86.97 42.78 84.84 37.04Q82.72 31.3 78.75 27.12Q74.79 22.95 69.33 20.75Q63.88 18.56 57.08 18.56Q48.16 18.56 41.5 22.45Q34.84 26.35 31.09 33.36Q27.34 40.37 27.34 49.86Q27.34 56.94 29.46 62.75Q31.59 68.56 35.55 72.73Q39.52 76.91 44.97 79.18Q50.42 81.44 57.08 81.44ZM123.8 100L163.46 0L183.57 0L222.8 100L199.29 100L192.78 81.87L153.54 81.87L146.88 100ZM186.12 63.74L173.23 28.05L160.2 63.74ZM270.25 101.56Q257.93 101.56 249.08 97.52Q240.23 93.48 232.86 85.27L247.31 70.96Q252.12 76.49 258 79.53Q263.88 82.58 271.67 82.58Q278.75 82.58 282.65 80.03Q286.54 77.48 286.54 72.95Q286.54 68.84 283.99 66.29Q281.44 63.74 277.27 61.9Q273.09 60.06 268.06 58.36Q263.03 56.66 258.07 54.46Q253.12 52.27 248.94 48.94Q244.76 45.61 242.21 40.58Q239.66 35.55 239.66 27.9Q239.66 18.7 244.12 12.04Q248.58 5.38 256.52 1.91Q264.45 -1.56 274.79 -1.56Q285.27 -1.56 293.98 2.12Q302.69 5.81 308.36 12.18L293.91 26.49Q289.38 21.81 284.77 19.55Q280.17 17.28 274.36 17.28Q268.56 17.28 265.16 19.48Q261.76 21.67 261.76 25.78Q261.76 29.6 264.31 31.94Q266.86 34.28 271.03 35.98Q275.21 37.68 280.24 39.38Q285.27 41.08 290.23 43.34Q295.18 45.61 299.36 49.08Q303.54 52.55 306.09 57.86Q308.64 63.17 308.64 70.96Q308.64 85.27 298.44 93.41Q288.24 101.56 270.25 101.56ZM328.47 100L328.47 0L350.71 0L350.71 38.95L390.37 38.95L390.37 0L412.75 0L412.75 100L390.37 100L390.37 58.22L350.71 58.22L350.71 100Z";

/**
 * "QASH" alone: the word's ink (x 4.53–412.75, y −1.7–107.93) with 10 units of margin all round.
 */
function logoSvg(colour: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-5.47 -11.7 428.22 129.63" width="1600" height="484">' +
    `<path fill="${colour}" d="${WORDMARK}"/>` +
    "</svg>"
  );
}

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
await writeFile(join(OUT, "logo.svg"), logoSvg(INDIGO));
await sharp(Buffer.from(logoSvg(INDIGO)))
  .png()
  .toFile(join(OUT, "logo.png"));
await sharp(Buffer.from(logoSvg("#FFFFFF")))
  .png()
  .toFile(join(OUT, "logo-dark.png"));
console.log("logo.svg, logo.png, logo-dark.png  1600x484");
