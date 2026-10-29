/**
 * A challenge's reads answer out of order (October 29, 2026, the What helped e2e flake): a read
 * sent before a save landed must never replace the newer answer, and a save's own answer is
 * taken as the newest. `useGroup` keeps only the latest request's answer.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { GroupDetail } from "../../src/data/api.ts";

const pending: Array<(detail: GroupDetail) => void> = [];

vi.mock("../../src/data/api.ts", async (actual) => ({
  ...(await actual<typeof import("../../src/data/api.ts")>()),
  api: {
    GET: () =>
      new Promise((resolve) => {
        pending.push((data) => resolve({ data, response: new Response(null, { status: 200 }) }));
      }),
  },
}));

const { useGroup } = await import("../../src/features/groups/useGroups.ts");

function detail(answered: number): GroupDetail {
  return { id: "g1", helped: { answered, counts: {} } } as unknown as GroupDetail;
}

describe("useGroup", () => {
  beforeEach(() => {
    pending.length = 0;
  });

  it("an older read answering last never replaces the newer one", async () => {
    const { result } = renderHook(() => useGroup("g1"));
    await waitFor(() => expect(pending).toHaveLength(1)); // the first read, still out
    let second: Promise<void> | undefined;
    act(() => {
      second = result.current.refresh();
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    // The newer read answers first, then the older one
    await act(async () => {
      pending[1]?.(detail(3));
      await second;
    });
    await act(async () => {
      pending[0]?.(detail(2));
    });
    expect(result.current.group?.helped?.answered).toBe(3);
  });

  it("a save's answer is the newest, even with a read still out", async () => {
    const { result } = renderHook(() => useGroup("g1"));
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => result.current.accept(detail(3)));
    await act(async () => {
      pending[0]?.(detail(2));
    });
    expect(result.current.group?.helped?.answered).toBe(3);
  });
});
