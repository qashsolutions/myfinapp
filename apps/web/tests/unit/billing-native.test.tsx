/**
 * Chunk 2.4, the web half of native billing: inside a shell the plan picker buys through the
 * store's payment sheet (the StackdPurchases plugin) and syncs the store's proof; managing and
 * cancelling live on the store's page; the Founding offer stays web-only; restore brings a
 * plan back. In a browser the Stripe flow is untouched (billing.test.tsx).
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { type FakeApi, freeBilling, installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function installShell(plugins: Record<string, unknown>) {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: plugins,
  };
}

describe("native billing (chunk 2.4)", () => {
  let api: FakeApi;
  beforeEach(() => {
    resetEntitlements();
    api = installFakeApi({ session: readySession(), billing: freeBilling() });
  });
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("buys through the store sheet, syncs the proof, and manages on the store page", async () => {
    const purchase = vi.fn(async ({ productId }: { productId: string; accountToken: string }) => ({
      jws: `proof:connected:yearly:${productId}`,
    }));
    const manageSubscriptions = vi.fn(async () => {});
    installShell({ StackdPurchases: { purchase, manageSubscriptions, restore: vi.fn() } });
    const user = userEvent.setup();
    renderApp("/me/plan");
    const card = await screen.findByRole("article", { name: "Connected" });
    await user.click(within(card).getByRole("button", { name: "Choose Connected" }));
    await waitFor(() =>
      expect(purchase).toHaveBeenCalledWith({
        productId: "com.stackd.app.connected.yearly",
        accountToken: "u1",
      }),
    );
    const synced = api.calls.find(
      (c) => c.method === "POST" && c.path === "/api/billing/native/sync",
    )?.body as Record<string, unknown>;
    expect(synced).toEqual({
      platform: "ios",
      jws: "proof:connected:yearly:com.stackd.app.connected.yearly",
      purchase_token: null,
    });
    await screen.findByText("Thanks! Your plan is updated.");
    const current = screen.getByRole("region", { name: "Current plan" });
    await waitFor(() => expect(current).toHaveTextContent("Connected · yearly"));

    // Managing happens on the store's own page, not Stripe's portal
    const manage = screen.getByRole("list", { name: "Manage your plan" });
    expect(within(manage).queryByText("Receipts & invoices")).toBeNull();
    await user.click(within(manage).getByText("Manage in the App Store"));
    expect(manageSubscriptions).toHaveBeenCalledTimes(1);
    expect(api.calls.filter((c) => c.path === "/api/billing/portal")).toEqual([]);
  });

  it("keeps the Founding offer on the website and restores past purchases", async () => {
    const restore = vi.fn(async () => ({ purchases: [{ jws: "proof:private:monthly" }] }));
    installShell({ StackdPurchases: { purchase: vi.fn(), restore, manageSubscriptions: vi.fn() } });
    const user = userEvent.setup();
    renderApp("/me/plan");
    const founding = await screen.findByRole("article", { name: "Founding member" });
    expect(founding).toHaveTextContent("sold on the website only");
    expect(within(founding).queryByRole("button", { name: "Become a Founding member" })).toBeNull();

    await user.click(screen.getByText("Restore purchases"));
    await screen.findByText("Restored. Your plan is updated.");
    expect(restore).toHaveBeenCalledWith({ accountToken: "u1" });
    const current = screen.getByRole("region", { name: "Current plan" });
    await waitFor(() => expect(current).toHaveTextContent("Private · monthly"));
  });

  it("a closed payment sheet changes nothing and says nothing", async () => {
    const purchase = vi.fn(async () => {
      const err = new Error("cancelled");
      err.name = "NotAllowedError";
      throw err;
    });
    installShell({ StackdPurchases: { purchase, restore: vi.fn(), manageSubscriptions: vi.fn() } });
    const user = userEvent.setup();
    renderApp("/me/plan");
    const card = await screen.findByRole("article", { name: "Private" });
    await user.click(within(card).getByRole("button", { name: "Choose Private" }));
    await waitFor(() => expect(purchase).toHaveBeenCalled());
    expect(api.calls.filter((c) => c.path === "/api/billing/native/sync")).toEqual([]);
    expect(screen.getByRole("region", { name: "Current plan" })).toHaveTextContent("Free");
  });
});
