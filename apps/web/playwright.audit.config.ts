import { devices } from "@playwright/test";
import base from "./playwright.config.ts";
export default {
  ...base,
  testDir: "e2e-audit",
  reporter: "list",
  retries: 0,
  workers: 1,
  use: { ...base.use, actionTimeout: 15_000, navigationTimeout: 20_000 },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], channel: "chrome" } },
    { name: "desktop", use: { viewport: { width: 1280, height: 900 }, channel: "chrome" } },
  ],
};
