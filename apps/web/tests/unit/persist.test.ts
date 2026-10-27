import {
  formatBytes,
  requestPersistence,
  shouldNudgeExport,
  storageEstimate,
} from "../../src/data/persist.ts";

describe("persistent storage", () => {
  afterEach(() => {
    // @ts-expect-error test cleanup of the stubbed API
    delete navigator.storage;
  });

  it("asks once and reports the answer", async () => {
    const persist = vi.fn(async () => true);
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persisted: async () => false,
        persist,
        estimate: async () => ({ usage: 2_300_000, quota: 1e9 }),
      },
    });
    expect(await requestPersistence()).toBe("persisted");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await storageEstimate()).toEqual({ usage: 2_300_000, quota: 1e9 });
  });

  it("reports denied and unsupported honestly", async () => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { persisted: async () => false, persist: async () => false },
    });
    expect(await requestPersistence()).toBe("denied");
    // @ts-expect-error test cleanup of the stubbed API
    delete navigator.storage;
    expect(await requestPersistence()).toBe("unsupported");
    expect(await storageEstimate()).toBeNull();
  });

  it("formats sizes and nudges exports after 20 entries or 30 days", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_300_000)).toBe("2.2 MB");
    const now = new Date("2026-10-10T00:00:00Z");
    expect(shouldNudgeExport(19, null, now)).toBe(false);
    expect(shouldNudgeExport(20, null, now)).toBe(true);
    expect(shouldNudgeExport(20, "2026-09-20T00:00:00Z", now)).toBe(false);
    expect(shouldNudgeExport(20, "2026-09-01T00:00:00Z", now)).toBe(true);
  });
});
