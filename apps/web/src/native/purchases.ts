/**
 * Store purchases through the shell (Phase 2, chunk 2.4; spec `purchases.ts`). The
 * StackdPurchases plugin wraps StoreKit 2 and Play Billing (contract in apps/mobile/README.md):
 * `purchase` runs the OS payment sheet with the user id as the account token and resolves the
 * store's own proof (a signed transaction JWS on iOS, a purchase token on Android), which
 * `POST /api/billing/native/sync` verifies server-side before anything changes. `restore` hands
 * back every proof the store still vouches for, so a reinstall gets its plan back. Outside a
 * shell none of this exists and the Stripe pages do the work.
 */

import { api, failureOf } from "../data/api.ts";
import { nativePlatform, nativePlugin } from "../lib/platform.ts";

interface PurchaseProof {
  jws?: string; // iOS: the transaction's jwsRepresentation
  purchaseToken?: string; // Android
}

interface StackdPurchasesPlugin {
  /** Rejects with { name: "NotAllowedError" } when the person closes the payment sheet. */
  purchase(args: { productId: string; accountToken: string }): Promise<PurchaseProof>;
  restore(args: { accountToken: string }): Promise<{ purchases: PurchaseProof[] }>;
  manageSubscriptions(): Promise<void>;
}

export function nativeBillingAvailable(): boolean {
  return nativePlugin("StackdPurchases") !== null;
}

async function syncProof(proof: PurchaseProof): Promise<boolean> {
  const platform = nativePlatform();
  if (!platform || (!proof.jws && !proof.purchaseToken)) return false;
  const r = await api.POST("/api/billing/native/sync", {
    body: {
      platform,
      jws: proof.jws ?? null,
      purchase_token: proof.purchaseToken ?? null,
    },
  });
  return failureOf(r) === null;
}

export type PurchaseOutcome = "synced" | "cancelled" | "failed";

/** The OS payment sheet for one product; the server verifies the proof before the plan moves. */
export async function buyPlanNative(
  productId: string,
  accountToken: string,
): Promise<PurchaseOutcome> {
  const plugin = nativePlugin<StackdPurchasesPlugin>("StackdPurchases");
  if (!plugin) return "failed";
  let proof: PurchaseProof;
  try {
    proof = await plugin.purchase({ productId, accountToken });
  } catch (err) {
    return (err as { name?: string } | null)?.name === "NotAllowedError" ? "cancelled" : "failed";
  }
  return (await syncProof(proof)) ? "synced" : "failed";
}

/** Re-syncs every purchase the store still vouches for. Returns how many landed. */
export async function restorePurchasesNative(accountToken: string): Promise<number> {
  const plugin = nativePlugin<StackdPurchasesPlugin>("StackdPurchases");
  if (!plugin) return 0;
  let purchases: PurchaseProof[];
  try {
    purchases = (await plugin.restore({ accountToken })).purchases;
  } catch {
    return 0;
  }
  let synced = 0;
  for (const proof of purchases) if (await syncProof(proof)) synced += 1;
  return synced;
}

/** The App Store / Google Play subscription page: renewing, switching and cancelling live there. */
export async function openStoreSubscriptions(): Promise<void> {
  const plugin = nativePlugin<StackdPurchasesPlugin>("StackdPurchases");
  if (!plugin) return;
  try {
    await plugin.manageSubscriptions();
  } catch {
    /* the OS page refused to open; the store app still works */
  }
}
