/**
 * Defect round 3 (October 29, 2026), invariants 57 and 58: an account closed when its plan
 * ended leads every signed-out open to the data it left on this device, never to a sign-in that
 * can't work; and a browser that may erase this device's data says so, from day 1 on an iPhone
 * tab, until a way out is done. Also: a locked app's plan screen says it is locked.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import {
  recordExport,
  resetLastOpen,
  STORAGE_CARD_GAP_DAYS,
  STORAGE_CARD_SNOOZE_DAYS,
  storageRisk,
} from "../../src/data/persist.ts";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { keptAccount, rememberKept } from "../../src/lib/keptAccount.ts";
import { lastAccount, rememberAccount } from "../../src/lib/lastAccount.ts";
import { installFakeApi, readySession, signedOut } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const DAY = 86_400_000;
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("an account closed when its plan ended (invariant 57)", () => {
  it("the closure forgets the remembered account, so Welcome never offers its passkey", async () => {
    rememberAccount("maya@example.com", "Maya");
    localStorage.setItem("qash.account_hash", JSON.stringify({ user_id: "u1", hash: "h1" }));
    installFakeApi({
      session: { ...signedOut(), deleted_user_id: "u1", deleted_reason: "plan_ended" },
    });
    renderApp("/kept");
    await waitFor(() => expect(keptAccount()?.user_id).toBe("u1"));
    expect(lastAccount()).toBeNull();
  });

  it("a second open, with nothing more from the server, still leads to the kept data", async () => {
    // As a device was left before this fix: the kept record and the remembered account both.
    const db = openDb("u1");
    await seedDefaults(db);
    rememberKept({ user_id: "u1", closed_at: "2026-10-20T12:00:00Z", email_hash: "h1" });
    rememberAccount("maya@example.com", "Maya");
    installFakeApi({ session: signedOut() });
    renderApp("/");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your data is safe here" }),
    ).toBeInTheDocument();
  });

  it("Welcome says the account closed and leads to the data, with no passkey button", async () => {
    rememberKept({ user_id: "u1", closed_at: "2026-10-20T12:00:00Z", email_hash: "h1" });
    rememberAccount("maya@example.com", "Maya");
    installFakeApi({ session: signedOut() });
    renderApp("/welcome");
    const entry = await screen.findByRole("region", {
      name: "Your account closed on Oct 20, 2026. Your data is still on this device.",
    });
    expect(within(entry).getByRole("link", { name: "See my data" })).toHaveAttribute(
      "href",
      "/kept",
    );
    expect(screen.queryByText(/Welcome back/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue with|Sign in with/ })).toBeNull();
    expect(screen.queryByText(/No Qash passkey/)).toBeNull();
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/signin");
    await waitFor(() => expect(lastAccount()).toBeNull());
  });

  it("a second report of the same closure keeps the first date", async () => {
    rememberKept({ user_id: "u1", closed_at: "2026-10-20T12:00:00Z", email_hash: "h1" });
    installFakeApi({
      session: { ...signedOut(), deleted_user_id: "u1", deleted_reason: "plan_ended" },
    });
    renderApp("/kept");
    expect(await screen.findByText(/Your Qash account closed on Oct 20, 2026/)).toBeInTheDocument();
    expect(keptAccount()?.closed_at).toBe("2026-10-20T12:00:00Z");
    expect(keptAccount()?.email_hash).toBe("h1");
  });
});

describe("a browser that may erase this device's data (invariant 58)", () => {
  const base = {
    iphoneTab: true,
    persistence: "denied" as const,
    backupOn: false,
    entryCount: 0,
    lastExportAt: null,
    snoozedAt: null,
    lastOpenAt: null,
    now: new Date("2026-10-29T12:00:00Z"),
  };
  const ago = (days: number) => new Date(base.now.getTime() - days * DAY).toISOString();

  it("the rule: iPhone tab from day 1 until a way out is done; snoozed, but back after a gap", () => {
    expect(storageRisk(base)).toBe("iphone_tab");
    expect(storageRisk({ ...base, backupOn: true })).toBeNull();
    expect(storageRisk({ ...base, lastExportAt: ago(2) })).toBeNull();
    expect(storageRisk({ ...base, lastExportAt: ago(31) })).toBe("iphone_tab");
    expect(storageRisk({ ...base, snoozedAt: ago(1) })).toBeNull();
    expect(storageRisk({ ...base, snoozedAt: ago(STORAGE_CARD_SNOOZE_DAYS) })).toBe("iphone_tab");
    expect(
      storageRisk({ ...base, snoozedAt: ago(1), lastOpenAt: ago(STORAGE_CARD_GAP_DAYS) }),
    ).toBe("iphone_tab");
    // Elsewhere: the export reminder, only where the browser hasn't promised to keep the data.
    const other = { ...base, iphoneTab: false };
    expect(storageRisk(other)).toBeNull(); // few entries yet
    expect(storageRisk({ ...other, entryCount: 20 })).toBe("export");
    expect(storageRisk({ ...other, entryCount: 20, persistence: "persisted" })).toBeNull();
    expect(storageRisk({ ...other, entryCount: 20, lastExportAt: ago(3) })).toBeNull();
  });

  describe("on Home", () => {
    beforeEach(() => {
      resetLastOpen();
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    });
    afterEach(() => vi.restoreAllMocks());

    it("an iPhone browser tab is told on day 1, and Not now quiets it", async () => {
      const user = userEvent.setup();
      installFakeApi({ session: readySession() });
      renderApp("/");
      const card = await screen.findByRole("region", { name: "Keep your data safe" });
      expect(card).toHaveTextContent("Review");
      expect(card).toHaveTextContent(
        "On iPhone, Safari can erase this data after 7 days without a visit. Add Qash to your Home Screen, or turn on backup.",
      );
      expect(within(card).getByRole("button", { name: "Add to Home Screen" })).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Download a copy" })).toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "Not now" }));
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: "Keep your data safe" })).toBeNull(),
      );
      expect(localStorage.getItem("stackd.storage_card_snoozed")).toBeTruthy();
    });

    it("Add to Home Screen opens the picture steps", async () => {
      const user = userEvent.setup();
      installFakeApi({ session: readySession() });
      renderApp("/");
      const card = await screen.findByRole("region", { name: "Keep your data safe" });
      await user.click(within(card).getByRole("button", { name: "Add to Home Screen" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent(/Share/);
    });

    it("a recent download hides it; the installed app never shows it", async () => {
      recordExport("u1", new Date());
      installFakeApi({ session: readySession() });
      const { unmount } = renderApp("/");
      expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole("region", { name: "Keep your data safe" })).toBeNull();
      unmount();
      localStorage.removeItem("stackd.last_export.u1");
      Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
      try {
        renderApp("/");
        expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByRole("region", { name: "Keep your data safe" })).toBeNull();
      } finally {
        Object.defineProperty(navigator, "standalone", { value: undefined, configurable: true });
      }
    });
  });
});

describe("a locked app's plan screen", () => {
  it("says it is locked and that download works, not the limits of a plan nobody has", async () => {
    resetEntitlements();
    const api = installFakeApi({ session: readySession() });
    api.access = {
      state: "lapsed",
      plan: "free",
      ended_at: new Date(Date.now() - DAY).toISOString(),
      delete_at: new Date(Date.now() + 6 * DAY).toISOString(),
    };
    renderApp("/me/plan");
    const current = await screen.findByRole("region", { name: "Current plan" });
    await waitFor(() =>
      expect(current).toHaveTextContent("Locked until you pick a plan · download still works"),
    );
    expect(current).not.toHaveTextContent(/jars and goals|statement account/);
  });

  it("a payment in dispute and a returned payment say the same plainly", async () => {
    for (const [state, line] of [
      ["paused", "Locked while the payment is checked · download still works"],
      ["ended", "Locked · download still works"],
    ] as const) {
      resetEntitlements();
      const api = installFakeApi({ session: readySession() });
      api.access = { state, plan: "private" };
      const { unmount } = renderApp("/me/plan");
      const current = await screen.findByRole("region", { name: "Current plan" });
      await waitFor(() => expect(current).toHaveTextContent(line));
      expect(current).not.toHaveTextContent(/jars and goals|statement account/);
      unmount();
    }
  });
});
