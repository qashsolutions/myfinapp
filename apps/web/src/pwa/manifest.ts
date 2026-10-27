import type { ManifestOptions } from "vite-plugin-pwa";

/**
 * Web app manifest (docs/spec.md: theme + background #3D5AFE, standalone; icons 512 any,
 * 512 maskable, 192).
 */
export const manifest: Partial<ManifestOptions> = {
  id: "/",
  name: "Qash",
  short_name: "Qash",
  description: "Keep more of what you earn. Your numbers stay on your device.",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  theme_color: "#3D5AFE",
  background_color: "#3D5AFE",
  categories: ["finance"],
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    {
      src: "/icons/icon-512-maskable.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};
