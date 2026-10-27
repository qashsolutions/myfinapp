import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (first run October 22, 2026): the real PWA in the installed Chrome against a
 * real API with its own database (stackd_e2e, :8100) and a dev server on :5174, so a run never
 * touches the everyday local stack. Sign-in codes are read from the API's console email log;
 * passkeys come from Chrome's virtual authenticator. Local only for now: `pnpm -C apps/web e2e`.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5174",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // The installed Chrome as it is (a Mac says Touch ID), not the Windows identity of the
    // "Desktop Chrome" profile.
    { name: "desktop", use: { viewport: { width: 1280, height: 800 }, channel: "chrome" } },
    {
      name: "phone",
      use: { ...devices["Pixel 7"], channel: "chrome" },
      // Tests tagged @phone; E2E_ALL=1 runs every journey at phone size too.
      grep: process.env.E2E_ALL ? /./ : /@phone/,
    },
  ],
  webServer: [
    {
      command: "mkdir -p e2e/.output && sh e2e/start-api.sh > e2e/.output/api.log 2>&1",
      url: "http://127.0.0.1:8100/health",
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: "STACKD_API_PROXY=http://127.0.0.1:8100 pnpm exec vite --port 5174 --strictPort",
      url: "http://localhost:5174",
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
