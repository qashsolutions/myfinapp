import { cx } from "@stackd/ui";
import { Link, useLocation } from "react-router";
import { activeTab, TABS } from "../tabs.ts";

/** Phone: the floating five-tab bar, text labels, active tab filled with accent-1. */
export function TabBar() {
  const current = activeTab(useLocation().pathname);
  return (
    <nav className="tabbar" aria-label="Primary">
      {TABS.map((t) => (
        <Link
          key={t.path}
          to={t.path}
          aria-current={current === t.path ? "page" : undefined}
          className={cx("tabbar__tab", current === t.path && "tabbar__tab--active")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
