import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { manifest } from "./src/pwa/manifest.ts";

// Which build this is (October 18, 2026): the commit in CI, "dev" locally, plus when it was built.
// The app shows it under Me and compares it with /version.json, which is never cached, so a
// phone whose offline copy got stuck still learns a new version exists (src/pwa/updates.ts).
const BUILD_ID = process.env.GITHUB_SHA?.slice(0, 7) ?? "dev";
const BUILD_TIME = new Date().toISOString();

function versionFile(): Plugin {
  return {
    name: "qash-version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ build: BUILD_ID, built_at: BUILD_TIME })}\n`,
      });
    },
  };
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    react(),
    versionFile(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/pwa",
      filename: "sw.ts",
      // A new worker waits until the user taps Refresh in the update toast (src/pwa/updates.ts).
      registerType: "prompt",
      injectRegister: false,
      manifest,
      includeAssets: [
        "icons/favicon.svg",
        "icons/favicon-32.png",
        "icons/apple-touch-icon-180.png",
      ],
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // pdf.js (1.6 MB, fast-follow 2) loads only when a PDF statement is picked, and the
        // OCR runtime (fast-follow 6, public/ocr: worker, cores, model) only when a receipt
        // is read; keeping both out of the precache keeps the install small. Each needs a
        // network the first time it is used.
        globIgnores: [
          // The logo files are for partners, stores and print (scripts/icons.ts); the app
          // never shows them.
          "icons/logo*",
          "**/pdfjs-*.js",
          "ocr/**",
          // The QR reader (Link a device, 47 kB gzip) loads only when someone scans, and
          // linking needs the network anyway.
          "**/jsQR-*.js",
          // Every look's fonts but Modern's load only when that look is picked; sw.ts caches
          // each file on first use, so the install stays small and a chosen look works offline.
          "**/public-sans-latin-*",
          "**/bungee-latin-*",
          "**/vt323-latin-*",
          "**/chakra-petch-latin-*",
          "**/fraunces-latin-*",
          "**/nunito-latin-*",
          "**/sora-latin-*",
          "**/plus-jakarta-sans-latin-*",
          "**/dela-gothic-one-latin-*",
          "**/m-plus-rounded-1c-latin-*",
          "**/dotgothic16-latin-*",
          "**/latin-[0-9]*-*.css",
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // The app calls /api on its own origin; in development that is proxied to the API.
  // In production a reverse proxy does the same, so cookies stay first-party.
  // STACKD_API_PROXY points a second dev server at another API (the e2e stack on :8100).
  server: {
    port: 5173,
    proxy: { "/api": process.env.STACKD_API_PROXY ?? "http://127.0.0.1:8000" },
  },
  preview: {
    port: 4173,
    proxy: { "/api": process.env.STACKD_API_PROXY ?? "http://127.0.0.1:8000" },
  },
});
