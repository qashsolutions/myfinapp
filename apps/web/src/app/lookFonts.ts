/**
 * Fonts for every look but Modern (docs/spec.md "Font loading": only the active look's fonts,
 * subset by Unicode range, font-display swap). Modern's Outfit is imported in main.tsx for every
 * build. The rest are dynamic imports, fetched the first time someone picks that look; the
 * service worker keeps them out of its precache (vite.config.ts) and caches each file on first
 * use (sw.ts), so a chosen look keeps its type offline. Self-hosted, pinned fontsource packages.
 */

import type { Look } from "@stackd/tokens";

const LOADERS: Record<Exclude<Look, "modern">, () => Promise<unknown>> = {
  pastel: () =>
    Promise.all([
      import("@fontsource/sora/latin-500.css"),
      import("@fontsource/sora/latin-600.css"),
      import("@fontsource/sora/latin-700.css"),
      import("@fontsource/plus-jakarta-sans/latin-400.css"),
      import("@fontsource/plus-jakarta-sans/latin-500.css"),
      import("@fontsource/plus-jakarta-sans/latin-600.css"),
    ]),
  minimal: () =>
    Promise.all([
      import("@fontsource/public-sans/latin-400.css"),
      import("@fontsource/public-sans/latin-500.css"),
      import("@fontsource/public-sans/latin-600.css"),
      import("@fontsource/public-sans/latin-700.css"),
    ]),
  retro: () =>
    Promise.all([
      import("@fontsource/bungee/latin-400.css"),
      import("@fontsource/vt323/latin-400.css"),
      import("@fontsource/chakra-petch/latin-400.css"),
      import("@fontsource/chakra-petch/latin-500.css"),
      import("@fontsource/chakra-petch/latin-600.css"),
      import("@fontsource/chakra-petch/latin-700.css"),
    ]),
  illustrative: () =>
    Promise.all([
      import("@fontsource/fraunces/latin-500.css"),
      import("@fontsource/fraunces/latin-600.css"),
      import("@fontsource/fraunces/latin-700.css"),
      import("@fontsource/nunito/latin-400.css"),
      import("@fontsource/nunito/latin-600.css"),
      import("@fontsource/nunito/latin-700.css"),
    ]),
  anime: () =>
    Promise.all([
      import("@fontsource/dela-gothic-one/latin-400.css"),
      import("@fontsource/m-plus-rounded-1c/latin-400.css"),
      import("@fontsource/m-plus-rounded-1c/latin-500.css"),
      import("@fontsource/m-plus-rounded-1c/latin-700.css"),
      import("@fontsource/dotgothic16/latin-400.css"),
    ]),
};

const loaded = new Set<Look>(["modern"]);

/** Loads a look's fonts once; the look switches at once and the text swaps in as they arrive. */
export async function loadLookFonts(look: Look): Promise<void> {
  if (loaded.has(look)) return;
  loaded.add(look);
  try {
    await LOADERS[look as Exclude<Look, "modern">]();
  } catch {
    loaded.delete(look); // try again on the next switch
  }
}
