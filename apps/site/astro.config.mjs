// @ts-check
import { defineConfig } from "astro/config";

// Static HTML only (docs/spec.md "Phase 1W"): no server, no image service, no client framework.
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL ?? "https://qash.solutions",
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  compressHTML: true,
  image: { service: { entrypoint: "astro/assets/services/noop" } },
});
