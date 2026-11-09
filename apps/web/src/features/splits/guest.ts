/**
 * A split-bill guest (spec "Guests"): someone in a group with no plan of their own, either new
 * (never picked a trial) or whose trial or plan ended while in a group. Their app has two tabs,
 * Splits and Me; the server says so in `access.split_guest`.
 */

import { type Access, useEntitlements } from "../billing/entitlements.ts";

export function isSplitGuest(access: Access | null | undefined): boolean {
  return Boolean(access?.split_guest) && (access?.state === "choose" || access?.state === "lapsed");
}

export function useSplitGuest(): boolean {
  const { entitlements, known } = useEntitlements();
  return known && isSplitGuest(entitlements.access);
}
