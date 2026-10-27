import "./settings.css";

import { useEffect } from "react";
import { Outlet, useLocation } from "react-router";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/useMediaQuery.ts";
import { SettingsSideNav } from "./SettingsNav.tsx";

/**
 * Every /me screen. From 900px a group's screen sits beside the list of groups (with search);
 * the hub itself and phones show one column. A search result arrives with
 * `state.highlight`, the id of the row to scroll to and flash once it has rendered.
 */
export function MeLayout() {
  const wide = useMediaQuery(DESKTOP_QUERY);
  const location = useLocation();
  const highlight = (location.state as { highlight?: string | null } | null)?.highlight ?? null;
  // The same result picked twice still flashes: each navigation has its own key.
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

  if (!wide || location.pathname === "/me") return <Outlet />;
  return (
    <div className="settings-split">
      <SettingsSideNav />
      <div className="settings-split__main">
        <Outlet />
      </div>
    </div>
  );
}
