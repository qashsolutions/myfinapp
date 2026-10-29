import { defineConfig, devices } from "@playwright/test";

// Ports and database can move (E2E_API_PORT, E2E_WEB_PORT, E2E_DB) so two checkouts can run at once.
const API_PORT = process.env.E2E_API_PORT ?? "8100";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "5174";

/**
 * End-to-end tests (first run October 22, 2026): the real PWA in the installed Chrome against a
 * real API with its own database (stackd_e2e, :8100) and a dev server on :5174, so a run never
 * touches the everyday local stack. Sign-in codes are read from the API's console email log;
 * passkeys come from Chrome's virtual authenticator. `pnpm -C apps/web e2e` on the Mac; CI's `e2e`
 * job runs the same journeys on every pull request (owner, October 27, 2026).
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
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
      url: `http://127.0.0.1:${API_PORT}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `STACKD_API_PROXY=http://127.0.0.1:${API_PORT} pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
