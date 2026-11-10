/**
 * A split screen that is gone never takes the server's late answer (November 10, 2026). CI failed
 * now and then with "ReferenceError: window is not defined" from useSplitGroup's refresh: a test
 * ended while its GET /api/splits was out, the environment was torn down, and the answer then
 * set state. Here the same happens on purpose: hold the answer, unmount, take `window` away as
 * teardown does, then answer.
 */

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { openDb } from "../../src/data/db.ts";

vi.mock("../../src/data/DbProvider.tsx", () => ({
  useDb: () => ({ db: openDb("u1") }),
  DbProvider: ({ children }: { children: ReactNode }) => children,
}));

const { useSplitGroup, useSplits } = await import("../../src/features/splits/useSplits.ts");

const LIST = {
  groups: [],
  can_create: true,
  guest: false,
  today: { added: 0, limit: 6 },
  double_check: false,
  blocked: false,
};

/** Hold every request until `release`; then answer the split list. */
function holdFetch() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  globalThis.fetch = async () => {
    await gate;
    return new Response(JSON.stringify(LIST), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return () => release();
}

/** Unmount, remove `window` like the environment's teardown, answer, and collect what escaped. */
async function answerAfterTeardown(unmount: () => void, release: () => void): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const onRejection = (reason: unknown) => escaped.push(reason);
  process.on("unhandledRejection", onRejection);
  unmount();
  const saved = globalThis.window;
  // @ts-expect-error: teardown removes it
  delete globalThis.window;
  try {
    release();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  } finally {
    globalThis.window = saved;
    process.off("unhandledRejection", onRejection);
  }
  return escaped;
}

describe("a split screen that is gone takes no late answer", () => {
  it("useSplitGroup", async () => {
    const release = holdFetch();
    const { unmount } = renderHook(() => useSplitGroup("g1"));
    expect(await answerAfterTeardown(unmount, release)).toEqual([]);
  });

  it("useSplits", async () => {
    const release = holdFetch();
    const { unmount } = renderHook(() => useSplits());
    expect(await answerAfterTeardown(unmount, release)).toEqual([]);
  });
});
