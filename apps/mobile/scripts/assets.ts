/**
 * Renders the store icons and launch screens for both shells from the same mark as the PWA's
 * icons (apps/web/scripts/icons.ts: the "Rising Q", a white Q with three marigold bars on
 * indigo). Run `pnpm -C apps/mobile assets` after changing the mark; the PNGs are committed with the projects and CI checks they
 * are current.
 *
 *   iOS      AppIcon-512@2x.png 1024 full bleed (iOS applies its own mask), mark at 80%
 *            Splash.imageset 2732x2732 ×3 (1x, 2x, 3x): indigo, mark at 18%
 *   Android  mipmap-*: ic_launcher (rounded square, 22%), ic_launcher_round (circle),
 *            ic_launcher_foreground (the mark alone on a transparent adaptive layer; the
 *            background colour is values/ic_launcher_background.xml)
 *            drawable*, drawable-port-*, drawable-land-*: splash, indigo, mark at 25% of the
 *            short side
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const INDIGO = "#4338FF";
const MARIGOLD = "#FFB020";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IOS = join(ROOT, "ios", "App", "App", "Assets.xcassets");
const ANDROID = join(ROOT, "android", "app", "src", "main", "res");

/** The mark in a 100-unit box (keep equal to apps/web/scripts/icons.ts): the Q and its bars. */
const MARK =
  '<circle cx="46" cy="46" r="28" fill="none" stroke="#FFFFFF" stroke-width="10"/>' +
  `<rect x="27" y="42" width="6" height="8" rx="2" fill="${MARIGOLD}"/>` +
  `<rect x="35.5" y="37" width="6" height="13" rx="2" fill="${MARIGOLD}"/>` +
  `<rect x="44" y="32" width="6" height="18" rx="2" fill="${MARIGOLD}"/>` +
  '<line x1="56" y1="56" x2="78" y2="78" stroke="#FFFFFF" stroke-width="10" stroke-linecap="round"/>';

function svg(
  width: number,
  height: number,
  markPx: number,
  background: { radius: number } | null,
): string {
  const offsetX = (width - markPx) / 2;
  const offsetY = (height - markPx) / 2;
  const scale = markPx / 100;
  const fill = background
    ? `<rect width="${width}" height="${height}" rx="${Math.round(background.radius)}" fill="${INDIGO}"/>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `${fill}<g transform="translate(${offsetX} ${offsetY}) scale(${scale})">${MARK}</g></svg>`
  );
}

async function png(path: string, markup: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await sharp(Buffer.from(markup)).png().toFile(path);
  console.log(path.slice(ROOT.length + 1));
}

// iOS
await png(
  join(IOS, "AppIcon.appiconset", "AppIcon-512@2x.png"),
  svg(1024, 1024, 1024 * 0.8, { radius: 0 }),
);
for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"])
  await png(join(IOS, "Splash.imageset", name), svg(2732, 2732, 2732 * 0.18, { radius: 0 }));

// Android launcher icons
const DENSITIES: Array<[string, number]> = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];
for (const [density, scale] of DENSITIES) {
  const size = 48 * scale;
  const dir = join(ANDROID, `mipmap-${density}`);
  await png(join(dir, "ic_launcher.png"), svg(size, size, size * 0.8, { radius: size * 0.22 }));
  await png(join(dir, "ic_launcher_round.png"), svg(size, size, size * 0.7, { radius: size / 2 }));
  const adaptive = 108 * scale;
  await png(
    join(dir, "ic_launcher_foreground.png"),
    svg(adaptive, adaptive, adaptive * 0.75, null),
  );
}

// Android splash screens (the pre-12 theme; Android 12+ draws the launcher icon itself)
const SPLASH: Array<[string, number, number]> = [
  ["drawable", 480, 320],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
];
for (const [dir, width, height] of SPLASH)
  await png(
    join(ANDROID, dir, "splash.png"),
    svg(width, height, Math.min(width, height) * 0.25, { radius: 0 }),
  );
