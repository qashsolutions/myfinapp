import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * A search result arrives with `state.highlight`, the id of the row to scroll to and flash once
 * the screen has rendered (any screen, not only Me's). The same result picked twice still flashes:
 * each navigation has its own key.
 */
export function useHighlightTarget() {
  const location = useLocation();
  const highlight = (location.state as { highlight?: string | null } | null)?.highlight ?? null;
  const request = highlight ? `${location.key} ${highlight}` : null;

  useEffect(() => {
    if (!request) return;
    const highlight = request.slice(request.indexOf(" ") + 1);
    let tries = 0;
    let clear: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      const el = document.getElementById(highlight);
      tries += 1;
      if (!el && tries < 30) return;
      clearInterval(timer);
      if (!el) return;
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      el.classList.add("settings-flash");
      clear = setTimeout(() => el.classList.remove("settings-flash"), 2400);
    }, 100);
    return () => {
      clearInterval(timer);
      if (clear) clearTimeout(clear);
    };
  }, [request]);
}
