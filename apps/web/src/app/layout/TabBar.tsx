import { cx } from "@stackd/ui";
import { NavLink } from "react-router";
import { TABS } from "../tabs.ts";

/** Phone: the floating five-tab bar, text labels, active tab filled with accent-1. */
export function TabBar() {
  return (
    <nav className="tabbar" aria-label="Primary">
      {TABS.map((t) => (
        <NavLink
          key={t.path}
          to={t.path}
          end={t.path === "/"}
          className={({ isActive }) => cx("tabbar__tab", isActive && "tabbar__tab--active")}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
