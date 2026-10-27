import { RULES_VERSION } from "@stackd/rules";
import { handle } from "@stackd/rules/engine";
import { answer } from "../../src/engine/answer.ts";
import {
  addMonths,
  createInlineTransport,
  createWorkerTransport,
  Engine,
  EngineError,
  engine,
  monthBounds,
  parseAmount,
  type WorkerLike,
} from "../../src/engine/bridge.ts";

/** A fake worker: answers with the real engine when `works`, else stays silent until failed. */
function fakeWorker(works: boolean) {
  const w: WorkerLike & { fail(): void; terminated: boolean; posted: number } = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminated: false,
    posted: 0,
    postMessage(request) {
      w.posted += 1;
      if (works) queueMicrotask(() => w.onmessage?.({ data: handle(request) } as MessageEvent));
    },
    terminate() {
      w.terminated = true;
    },
    fail() {
      w.onerror?.(new ErrorEvent("error", { message: "failed to load" }));
    },
  };
  return w;
}

describe("engine bridge", () => {
  it("falls back to the inline transport where there is no Worker (jsdom)", () => {
    expect(typeof Worker).toBe("undefined");
    expect(engine).toBeInstanceOf(Engine);
  });

  it("answers from the device with the rules version stamped", async () => {
    expect(await parseAmount("$1,234.56")).toBe(123456);
    expect(await parseAmount("(42.17)")).toBe(-4217);
    expect(engine.rulesVersion).toBe(RULES_VERSION);
    expect(await monthBounds("2026-10-09")).toMatchObject({
      start: "2026-10-01",
      end: "2026-10-31",
    });
    expect(await addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("turns a RuleError into EngineError with the stable code", async () => {
    await expect(parseAmount("")).rejects.toMatchObject({
      name: "EngineError",
      code: "invalid_amount",
    });
    await expect(monthBounds("2026-02-30")).rejects.toBeInstanceOf(EngineError);
  });

  it("a worker that fails to load hands its waiting calls to the inline engine", async () => {
    const w = fakeWorker(false);
    const e = new Engine(createWorkerTransport(() => w));
    const a = e.call<{ cents: number }>("money.parse_amount", { text: "1.50" });
    const b = e.call<{ cents: number }>("money.parse_amount", { text: "" });
    w.fail();
    expect(w.terminated).toBe(true);
    expect((await a).cents).toBe(150);
    await expect(b).rejects.toMatchObject({ code: "invalid_amount" });
    // later calls go inline too
    expect(await e.call<{ cents: number }>("money.parse_amount", { text: "2" })).toEqual({
      cents: 200,
    });
    expect(w.posted).toBe(2);
  });

  it("a worker that can't be created at all: inline from the start", async () => {
    const e = new Engine(
      createWorkerTransport(() => {
        throw new Error("blocked");
      }),
    );
    expect(await e.call<{ cents: number }>("money.parse_amount", { text: "3" })).toEqual({
      cents: 300,
    });
  });

  it("a working worker answers and is kept", async () => {
    const w = fakeWorker(true);
    const e = new Engine(createWorkerTransport(() => w));
    expect(await e.call<{ cents: number }>("money.parse_amount", { text: "4" })).toEqual({
      cents: 400,
    });
    expect(w.terminated).toBe(false);
  });

  it("an unexpected throw inside the engine fails the call instead of hanging", async () => {
    const e = new Engine(createInlineTransport());
    await expect(e.call("money.parse_amount", null as never)).rejects.toMatchObject({
      code: "engine_failed",
    });
  });

  it("one call that throws inside the worker fails alone; the worker keeps the rest", async () => {
    // The worker answers through `answer` (worker.ts), as the real one does.
    const made: Array<ReturnType<typeof fakeWorker>> = [];
    const e = new Engine(
      createWorkerTransport(() => {
        const w = fakeWorker(true);
        w.postMessage = (request) => {
          w.posted += 1;
          queueMicrotask(() => w.onmessage?.({ data: answer(request) } as MessageEvent));
        };
        made.push(w);
        return w;
      }),
    );
    await expect(e.call("money.parse_amount", null as never)).rejects.toMatchObject({
      code: "engine_failed",
    });
    expect(await e.call<{ cents: number }>("money.parse_amount", { text: "5" })).toEqual({
      cents: 500,
    });
    expect(made).toHaveLength(1);
    expect(made[0]?.terminated).toBe(false);
    expect(made[0]?.posted).toBe(2); // both calls went to the worker, none ran on the page
  });

  it("a worker that crashes after working is replaced by a fresh one, not the page", async () => {
    const made: Array<ReturnType<typeof fakeWorker>> = [];
    const e = new Engine(
      createWorkerTransport(() => {
        const w = fakeWorker(made.length > 0); // the first answers once, then crashes
        if (made.length === 0)
          w.postMessage = (request) => {
            w.posted += 1;
            if (w.posted === 1)
              queueMicrotask(() => w.onmessage?.({ data: handle(request) } as MessageEvent));
          };
        made.push(w);
        return w;
      }),
    );
    expect(await e.call<{ cents: number }>("money.parse_amount", { text: "1" })).toEqual({
      cents: 100,
    });
    const waiting = e.call<{ cents: number }>("money.parse_amount", { text: "6" });
    made[0]?.fail();
    expect(await waiting).toEqual({ cents: 600 }); // re-sent to the new worker
    expect(made).toHaveLength(2);
    expect(made[0]?.terminated).toBe(true);
    expect(made[1]?.posted).toBe(1);
  });

  it("keeps concurrent calls apart by id", async () => {
    const e = new Engine(createInlineTransport());
    const results = await Promise.all([
      e.call<{ cents: number }>("money.parse_amount", { text: "1" }),
      e.call<{ cents: number }>("money.parse_amount", { text: "2" }),
      e.call<{ cents: number }>("money.parse_amount", { text: "3" }),
    ]);
    expect(results.map((r) => r.cents)).toEqual([100, 200, 300]);
    e.terminate();
  });
});
