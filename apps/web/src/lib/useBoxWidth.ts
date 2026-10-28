import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * A chart's real width in pixels (October 28, 2026), so an SVG drawn one unit to one pixel keeps
 * its labels the same size on a phone and a computer instead of scaling them up with the card.
 */
export function useBoxWidth(
  fallback: number,
  min = 240,
): [RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(Math.max(min, w));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [min]);
  return [box, width];
}
