/**
 * Read-only bank and card linking (Phase 3, chunk 3.2; docs/security/linking.md). The server
 * hands back a Hosted Link URL; the user links on the provider's page and comes back to
 * /me/linking/done. The shared accounts (name, last four, type) arrive once, here, and become
 * device accounts; the server keeps only the sealed token and the institution's name.
 */

import type { components } from "@stackd/api-client";
import { useCallback, useEffect, useState } from "react";
import {
  type ApiFailure,
  api,
  failureOf,
  OFFLINE_MESSAGE,
  RECOVERY_HOLD_MESSAGE,
} from "../../data/api.ts";
import { type Account, type AccountType, newId, type StackdDb } from "../../data/db.ts";
import { goExternal } from "../billing/billing.ts";

export type LinkingOut = components["schemas"]["LinkingOut"];
export type FinishOut = components["schemas"]["FinishOut"];
export type LinkedConnection = components["schemas"]["LinkedConnection"];
export type LinkedAccount = components["schemas"]["LinkedAccount"];

export function isFailure(v: unknown): v is ApiFailure {
  return typeof v === "object" && v !== null && "status" in v && "code" in v;
}

export function useLinking() {
  const [status, setStatus] = useState<LinkingOut | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const refresh = useCallback(async () => {
    const r = await api.GET("/api/linking");
    const failure = failureOf(r);
    if (failure) setError(failure);
    else {
      setError(null);
      setStatus(r.data as LinkingOut);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, error, refresh };
}

/** Ask the server for a Hosted Link page and go there. Call after `useStepUp().confirm`. */
export async function startLink(): Promise<ApiFailure | null> {
  const r = await api.POST("/api/linking/start");
  const failure = failureOf(r);
  if (failure) return failure;
  goExternal((r.data as { url: string }).url);
  return null;
}

/** "Sign in again" (chunk 3.4): Plaid's update mode for a connection the bank paused. */
export async function startRelink(connectionId: string): Promise<ApiFailure | null> {
  const r = await api.POST("/api/linking/{connection_id}/relink", {
    params: { path: { connection_id: connectionId } },
  });
  const failure = failureOf(r);
  if (failure) return failure;
  goExternal((r.data as { url: string }).url);
  return null;
}

export async function finishLink(sessionId: string): Promise<FinishOut | ApiFailure> {
  const r = await api.POST("/api/linking/finish", { body: { session_id: sessionId } });
  return failureOf(r) ?? (r.data as FinishOut);
}

export async function disconnect(db: StackdDb, connectionId: string): Promise<ApiFailure | null> {
  const r = await api.DELETE("/api/linking/{connection_id}", {
    params: { path: { connection_id: connectionId } },
  });
  const failure = failureOf(r);
  if (failure && failure.status !== 404) return failure;
  await unlinkAccounts(db, connectionId);
  return null;
}

/** Plaid's account type → ours; anything else (loans, brokerage) is not used. */
export function accountTypeOf(a: LinkedAccount): AccountType | null {
  if (a.type === "credit") return "credit_card";
  if (a.type !== "depository") return null;
  return a.subtype === "savings" ? "savings" : a.subtype === "checking" ? "checking" : null;
}

/**
 * Turn the shared accounts into device accounts. An account already linked keeps its place;
 * one the user imported statements into (same type and last four) is adopted, so linked and
 * uploaded entries share one account; otherwise a new account is made. Returns what was used.
 */
export async function attachAccounts(
  db: StackdDb,
  connections: LinkedConnection[],
  now: Date = new Date(),
): Promise<{ used: Account[]; skipped: LinkedAccount[] }> {
  const used: Account[] = [];
  const skipped: LinkedAccount[] = [];
  await db.transaction("rw", db.accounts, async () => {
    const existing = await db.accounts.toArray();
    for (const conn of connections) {
      for (const shared of conn.accounts) {
        const type = accountTypeOf(shared);
        if (!type) {
          skipped.push(shared);
          continue;
        }
        const ref = { connection_id: conn.id, account_id: shared.account_id };
        const match =
          existing.find((a) => a.linked?.account_id === shared.account_id) ??
          existing.find(
            (a) => !a.linked && a.type === type && shared.mask !== null && a.last4 === shared.mask,
          );
        if (match) {
          const updated: Account = {
            ...match,
            linked: ref,
            institution: match.institution ?? conn.institution_name,
          };
          await db.accounts.put(updated);
          Object.assign(match, updated);
          used.push(updated);
        } else {
          const account: Account = {
            id: newId(),
            label: shared.name,
            type,
            last4: shared.mask,
            institution: conn.institution_name,
            currency: "USD",
            created_at: now.toISOString(),
            linked: ref,
          };
          await db.accounts.add(account);
          existing.push(account);
          used.push(account);
        }
      }
    }
  });
  return { used, skipped };
}

/** After Disconnect: the accounts and every entry stay; only the link is forgotten. */
export async function unlinkAccounts(db: StackdDb, connectionId: string): Promise<void> {
  await db.transaction("rw", db.accounts, async () => {
    const all = await db.accounts.toArray();
    for (const a of all) {
      if (a.linked?.connection_id === connectionId) await db.accounts.put({ ...a, linked: null });
    }
  });
}

export const LINK_ERRORS: Record<string, string> = {
  plan_limit: "Your plan's connections are all in use. Disconnect one, or see plans.",
  linking_unavailable: "Linking isn't available right now. Statement upload still works.",
  session_used: "That link was already finished. Your connections are below.",
  session_expired: "That link took too long. Start again from Linked banks & cards.",
  not_found: "We couldn't find that link. Start again from Linked banks & cards.",
  login_required: "Your bank needs you to sign in again. Tap Sign in again next to it.",
  offline: OFFLINE_MESSAGE,
};

export function linkErrorText(code: string): string {
  if (code === "recently_recovered") return RECOVERY_HOLD_MESSAGE;
  return LINK_ERRORS[code] ?? "Something went wrong reaching your bank's provider. Try again.";
}
