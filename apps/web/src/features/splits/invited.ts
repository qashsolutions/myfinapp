import { useLiveQuery } from "dexie-react-hooks";
import { useDb } from "../../data/DbProvider.tsx";
import type { StackdDb } from "../../data/db.ts";

/**
 * Who each invite went to (owner, November 11, 2026). The server keeps only a hash of the
 * address, so the organizer's own device remembers what they typed: `settings`
 * `split.invited.<invite id>`, synced in the encrypted backup like other settings, never sent
 * anywhere else.
 */
const PREFIX = "split.invited.";

export async function rememberInvite(db: StackdDb, inviteId: string, email: string) {
  await db.settings.put({
    key: `${PREFIX}${inviteId}`,
    value: email.trim(),
    updated_at: new Date().toISOString(),
  });
}

/** Invite id → the address typed, for the invites this device (or a restored backup) sent. */
export function useInvitedEmails(): Map<string, string> {
  const { db } = useDb();
  const rows = useLiveQuery(() => db.settings.where("key").startsWith(PREFIX).toArray(), [db]);
  return new Map((rows ?? []).map((r) => [r.key.slice(PREFIX.length), String(r.value)]));
}

/** The same inbox, as people type it: case and spaces don't matter. */
export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A day since it was sent or last reminded: the server's rule, shown before asking it. */
export function canRemindNow(
  invite: { created_at: string; reminded_at?: string | null },
  now: number = Date.now(),
): boolean {
  return now - Date.parse(invite.reminded_at ?? invite.created_at) >= 86_400_000;
}
