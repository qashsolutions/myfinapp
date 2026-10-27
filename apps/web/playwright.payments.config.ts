import { defineConfig } from "@playwright/test";

/**
 * Payments end to end (October 24, 2026): the real app and Stripe's real hosted Checkout in
 * test mode, with Stripe's published test cards and bank accounts, real webhooks forwarded by
 * `stripe listen`, and test clocks for anything that takes time. Needs the network and the
 * test keys in services/api/.env; costs nothing. Local only: `pnpm -C apps/web e2e:payments`.
 */
export default defineConfig({
  testDir: "e2e-payments",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-payments" }]],
  outputDir: "test-results-payments",
  use: {
    baseURL: "http://localhost:5174",
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "mkdir -p e2e/.output && sh e2e-payments/start-api.sh > e2e/.output/api.log 2>&1",
      url: "http://127.0.0.1:8100/health",
      timeout: 180_000,
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
