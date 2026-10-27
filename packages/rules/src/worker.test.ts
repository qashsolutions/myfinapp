/** Every golden case through the worker protocol on a real worker thread. */

import { Worker } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EngineRequest, EngineResponse } from "./engine.ts";
import { loadGoldenCases } from "./golden.ts";

const cases = loadGoldenCases();
let worker: Worker;
let nextId = 1;
const pending = new Map<number, (r: EngineResponse) => void>();

function call(rule: string, input: EngineRequest["input"]): Promise<EngineResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, rule, input } satisfies EngineRequest);
  });
}

beforeAll(() => {
  worker = new Worker(new URL("./worker.node.ts", import.meta.url));
  worker.on("message", (response: EngineResponse) => {
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
});

afterAll(async () => {
  await worker.terminate();
});

describe("worker protocol", () => {
  it("answers every golden case identically from a worker thread", async () => {
    const results = await Promise.all(cases.map((c) => call(c.rule, c.input)));
    for (const [i, response] of results.entries()) {
      const c = cases[i];
      if (!c) throw new Error("case index mismatch");
      const actual = response.ok ? response.result : { error: response.error };
      expect(actual, `${c.rule}/${c.name}`).toEqual(c.expected);
    }
  });

  it("preserves request ids under concurrency", async () => {
    const a = call("money.pct_of", { cents: 500000, bps: 5000 });
    const b = call("money.pct_of", { cents: 100, bps: 1000 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && ra.result).toEqual({ cents: 250000 });
    expect(rb.ok && rb.result).toEqual({ cents: 10 });
  });
});
