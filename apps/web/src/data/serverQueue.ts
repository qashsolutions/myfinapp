/**
 * Server-bound writes only (docs/spec.md: groups, alerts, settings). Money data never goes
 * through here. Each row is one target and holds the latest value, so a device that was
 * offline sends one request per target when it is back, not a history.
 */

import { api } from "./api.ts";
import type { ServerQueueItem, StackdDb } from "./db.ts";

export async function enqueueGroupProgress(
  db: StackdDb,
  groupId: string,
  progressBps: number,
): Promise<void> {
  await db.server_queue.put({
    id: `group_progress:${groupId}`,
    kind: "group_progress",
    payload: { group_id: groupId, progress_bps: progressBps },
    created_at: new Date().toISOString(),
    attempts: 0,
  });
}

/**
 * Drop the row that was sent, unless a newer value for the same target was queued while it was
 * on the way: that one stays for the next pass (flushServerQueue runs another).
 */
async function settle(db: StackdDb, sent: ServerQueueItem): Promise<void> {
  await db.transaction("rw", db.server_queue, async () => {
    const now = await db.server_queue.get(sent.id);
    if (!now) return;
    const same =
      now.created_at === sent.created_at &&
      JSON.stringify(now.payload) === JSON.stringify(sent.payload);
    if (same) await db.server_queue.delete(sent.id);
  });
}

let flushing: Promise<void> | null = null;
let again = false;

async function pass(db: StackdDb): Promise<void> {
  let items: ServerQueueItem[];
  try {
    items = await db.server_queue.orderBy("created_at").toArray();
  } catch {
    return; // the database is closed (sign-out, test teardown): nothing to send now
  }
  for (const item of items) {
    try {
      if (item.kind === "group_progress") {
        const { response } = await api.PUT("/api/groups/{group_id}/progress", {
          params: { path: { group_id: item.payload.group_id } },
          body: { progress_bps: item.payload.progress_bps },
        });
        // 404: no longer a member. Drop it rather than retry forever.
        if (!response.ok && response.status !== 404) throw new Error(String(response.status));
      }
      await settle(db, item);
    } catch {
      try {
        await db.server_queue.update(item.id, { attempts: item.attempts + 1 });
      } catch {
        return;
      }
    }
  }
}

/**
 * Send everything queued; a failure leaves the row for the next flush. One flush at a time,
 * and a flush asked for mid-flush runs another pass, so a value queued during a send still goes.
 */
export function flushServerQueue(db: StackdDb): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    do {
      again = false;
      await pass(db);
    } while (again);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
