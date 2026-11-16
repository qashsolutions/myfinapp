import "./settings.css";

import { Outlet, useLocation } from "react-router";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/useMediaQuery.ts";
import { SettingsSideNav } from "./SettingsNav.tsx";

/**
 * Every /me screen. From 900px a group's screen sits beside the list of groups (with search);
 * the hub itself and phones show one column. A search result's row is flashed by the app's frame
 * (features/search/highlight.ts).
 */
export function MeLayout() {
  const wide = useMediaQuery(DESKTOP_QUERY);
  const location = useLocation();
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
