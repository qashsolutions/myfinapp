import { useEffect, useState } from "react";

/** Reactive matchMedia. Reads synchronously on first render, so the first paint is right. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window !== "undefined" && (window.matchMedia?.(query).matches ?? false),
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * The breakpoint where the tab bar becomes a side rail. 900px, not 600px: below it a 248px
 * rail leaves too little room, so phones, narrow windows and tablets in portrait keep the tab
 * bar (owner feedback, October 12, 2026).
 */
export const WIDE_QUERY = "(min-width: 900px)";

/** From here two panes fit side by side (docs/spec.md "Desktop / tablet layout": ≥ 900px). */
export const DESKTOP_QUERY = "(min-width: 900px)";
