/**
 * Safe to spend never pairs a forecast with a day it doesn't cover, and a rule refusal never
 * escapes (invariant 53; November 10, 2026). A forecast made on October 10 runs through
 * November 9: asked about November 10 it has no window left, and the hook threw
 * `invalid_range` as an unhandled rejection instead of showing nothing.
 */

import { renderHook, waitFor } from "@testing-library/react";
import type { ForecastView } from "../../src/features/forecast/useForecast.ts";
import { useSafeToSpend } from "../../src/features/insights/useSafeToSpend.ts";

function viewFrom(first: string, days: number): ForecastView {
  const start = Date.parse(`${first}T00:00:00Z`);
  const list = Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    balance_cents: 100_000 - i * 1_000,
  }));
  return {
    loading: false,
    account: null,
    anchor: null,
    start: null,
    daily: null,
    upcoming: { items: [] },
    projection: { days: list },
    bufferCents: 0,
    series: new Map(),
    needsBalance: false,
  } as unknown as ForecastView;
}

describe("safe to spend and the forecast's own days", () => {
  it("shows nothing, and throws nothing, for a day after the forecast ends", async () => {
    const view = viewFrom("2026-10-10", 31); // October 10 through November 9
    const { result } = renderHook(() => useSafeToSpend(view, "2026-11-10"));
    // Long enough for the engine call to settle either way.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toBeNull();
  });

  it("shows nothing for a day before the forecast starts", async () => {
    const view = viewFrom("2026-10-10", 31);
    const { result } = renderHook(() => useSafeToSpend(view, "2026-10-09"));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toBeNull();
  });

  it("still answers for a day the forecast covers", async () => {
    const view = viewFrom("2026-10-10", 31);
    const { result } = renderHook(() => useSafeToSpend(view, "2026-10-10"));
    await waitFor(() => expect(result.current).not.toBeNull());
  });
});
