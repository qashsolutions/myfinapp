/**
 * Inside a Capacitor shell (Phase 2) the page is served from the app's host on a local scheme;
 * the API is that host over https. In a browser nothing changes: same origin.
 */
import { apiOrigin } from "../../src/data/api.ts";

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

it("calls the API on its own origin in a browser and on https://<host> inside a shell", () => {
  expect(apiOrigin()).toBe(window.location.origin);
  (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  expect(apiOrigin()).toBe(`https://${window.location.hostname}`);
  (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => false };
  expect(apiOrigin()).toBe(window.location.origin);
});
