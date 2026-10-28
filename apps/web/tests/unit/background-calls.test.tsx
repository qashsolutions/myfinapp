/**
 * Auto-lock counts only what the person does (owner decision, October 28, 2026): every call the
 * app makes on its own carries `X-Qash-Background: 1`, which the server never counts as
 * activity, and a call made for a person's tap or a screen they opened carries nothing. When
 * the screen locks, the server is told to lock this session too.
 */

import { act, screen, waitFor } from "@testing-library/react";
import { pullBackup, pushBackup, syncBackup } from "../../src/data/backup/sync.ts";
import { openDb } from "../../src/data/db.ts";
import { enqueueGroupProgress, flushServerQueue } from "../../src/data/serverQueue.ts";
import { syncHousehold } from "../../src/features/household/householdSync.ts";
import { syncAll, syncIfDue } from "../../src/features/linking/sync.ts";
import { installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const BG = "x-qash-background";
type Call = { method: string; path: string; headers: Record<string, string> };
const marked = (c: Call) => c.headers[BG] === "1";

function connection(id: string) {
  return {
    id,
    institution_name: "First Platypus Bank",
    created_at: "2026-10-01T00:00:00Z",
    status: "ok",
    updates_available: true,
    last_synced_at: null,
  };
}

describe("background calls are marked; a person's calls are not", () => {
  it("the shell's alert schedule and entitlements are background; a screen's own read is not", async () => {
    const api = installFakeApi({ session: readySession() });
    renderApp("/me/security");
    await screen.findByRole("heading", { level: 1, name: "Security & backup" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "PUT" && c.path === "/api/alerts/schedule")).toBe(
        true,
      ),
    );
    const of = (method: string, path: string) =>
      api.calls.filter((c) => c.method === method && c.path === path);
    expect(of("PUT", "/api/alerts/schedule").every(marked)).toBe(true);
    expect(of("GET", "/api/billing/entitlements").length).toBeGreaterThan(0);
    expect(of("GET", "/api/billing/entitlements").every(marked)).toBe(true);
    // The schedule's inputs (prefs, challenges) are read in the background too.
    expect(of("GET", "/api/notifications/settings").every(marked)).toBe(true);
    expect(of("GET", "/api/groups").every(marked)).toBe(true);
    // The screen the person opened: unmarked.
    await waitFor(() => expect(of("GET", "/api/security/passkeys").length).toBeGreaterThan(0));
    expect(of("GET", "/api/security/passkeys").some(marked)).toBe(false);
    // The session check never counted as activity anyway, and stays unmarked.
  });

  it("backup: the timed sync is background, Back up now and a restore are the person's", async () => {
    const api = installFakeApi({ session: readySession(), billing: privateBilling() });
    const db = openDb("u1");
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await db.settings.put({ key: "backup.key", value: key, updated_at: "x" });
    api.backup.key = { key_version: 1 } as never; // the server holds the wrapped key
    await syncBackup(db, "u1", "test");
    const sync = api.calls.filter((c) => c.path.startsWith("/api/backup/"));
    expect(sync.length).toBeGreaterThan(0);
    expect(sync.every(marked)).toBe(true);

    api.calls.length = 0;
    await pushBackup(db, "u1", "test", { force: true });
    await pullBackup(db, "u1");
    const mine = api.calls.filter((c) => c.path.startsWith("/api/backup/"));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some(marked)).toBe(false);
    db.close();
  });

  it("household: the shell's round is background", async () => {
    const api = installFakeApi({ session: readySession() });
    const db = openDb("u1");
    await syncHousehold(db, "u1", "2026-10-10");
    const calls = api.calls.filter((c) => c.path.startsWith("/api/household"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(marked)).toBe(true);
    db.close();
  });

  it("linked banks: the due pull is background, Sync now is the person's", async () => {
    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
    });
    api.linking.connections.push(connection("bc1"));
    api.linking.syncPages.bc1 = [{ added: [] }];
    const db = openDb("u1");
    await db.accounts.add({
      id: "a1",
      label: "Checking",
      type: "checking",
      institution: "First Platypus Bank",
      last4: "1234",
      currency: "USD",
      linked: { connection_id: "bc1", account_id: "acc-1" },
      created_at: "2026-10-01T00:00:00Z",
    });
    await syncIfDue(db, new Date("2026-10-10T12:00:00Z"));
    const due = api.calls.filter((c) => c.path.startsWith("/api/linking"));
    expect(due.some((c) => c.path === "/api/linking/bc1/sync")).toBe(true);
    expect(due.every(marked)).toBe(true);

    api.calls.length = 0;
    await syncAll(db, [{ id: "bc1", status: "ok" }], new Date("2026-10-10T13:00:00Z"));
    const mine = api.calls.filter((c) => c.path.startsWith("/api/linking"));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some(marked)).toBe(false);
    db.close();
  });

  it("a challenge's progress is flushed in the background", async () => {
    const api = installFakeApi({ session: readySession() });
    const db = openDb("u1");
    await enqueueGroupProgress(db, "g1", 2500);
    await flushServerQueue(db);
    const calls = api.calls.filter((c) => c.path === "/api/groups/g1/progress");
    expect(calls.length).toBe(1);
    expect(calls.every(marked)).toBe(true);
    db.close();
  });
});

describe("the screen lock locks the server's session too", () => {
  it("after 5 idle minutes the app asks the server to lock this session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const api = installFakeApi({ session: readySession() });
      renderApp("/budget");
      expect(await screen.findByRole("heading", { level: 1, name: "Budget" })).toBeInTheDocument();
      expect(api.calls.some((c) => c.path === "/api/auth/lock")).toBe(false);
      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000 + 30 * 1000);
      });
      expect(screen.getByRole("heading", { name: "Qash is locked" })).toBeInTheDocument();
      // waitFor polls with setInterval, which is faked here: wait on real timeouts instead.
      const locks = () =>
        api.calls.filter((c) => c.method === "POST" && c.path === "/api/auth/lock");
      for (let i = 0; i < 50 && locks().length === 0; i++)
        await act(() => new Promise((r) => setTimeout(r, 20)));
      act(() => {
        vi.advanceTimersByTime(60 * 1000); // more checks while locked: still told once
      });
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(locks()).toHaveLength(1);
      expect(api.session.locked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
