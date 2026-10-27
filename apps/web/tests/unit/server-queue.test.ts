import { openDb } from "../../src/data/db.ts";
import { enqueueGroupProgress, flushServerQueue } from "../../src/data/serverQueue.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";

describe("server queue", () => {
  it("a value queued while the last one is on the way is still sent, not deleted with it", async () => {
    installFakeApi({ session: readySession() });
    const sent: number[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const real = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.method === "PUT" && req.url.includes("/progress")) {
        sent.push(Number((await req.clone().json()).progress_bps));
        if (first) {
          first = false;
          await held; // the first send is still on the way
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return real(input, init);
    };
    const db = openDb("u1");
    await enqueueGroupProgress(db, "g1", 4000);
    const flushing = flushServerQueue(db);
    await vi.waitFor(() => expect(sent).toEqual([4000]));
    await enqueueGroupProgress(db, "g1", 6000);
    const again = flushServerQueue(db);
    release();
    await Promise.all([flushing, again]);
    expect(sent).toEqual([4000, 6000]);
    expect(await db.server_queue.count()).toBe(0);
    globalThis.fetch = real;
  });
});
