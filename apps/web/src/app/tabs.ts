/** The five tabs, in order (docs/spec.md "Navigation & screens"). Paths only: no components here. */
export interface Tab {
  path: string;
  label: string;
}

export const TABS: readonly Tab[] = [
  { path: "/", label: "Home" },
  { path: "/budget", label: "Budget" },
  { path: "/goals", label: "Goals" },
  { path: "/insights", label: "Insights" },
  { path: "/me", label: "Me" },
];

/**
 * Screens outside a tab's own path that belong to the tab they are reached from (October 29,
 * 2026): What if, the month review and credit habits open from Insights. A path not listed here
 * belongs to the tab whose path it starts with ("/insights/fixed-flexible" → Insights), or to none
 * (Subscriptions, reached from Bills, lights no tab, as before).
 */
const REACHED_FROM: Readonly<Record<string, string>> = {
  "/what-if": "/insights",
  "/month-review": "/insights",
  "/credit-habits": "/insights",
};

/** The tab path to show as current for a location, or null when none is. */
export function activeTab(pathname: string): string | null {
  const own = Object.entries(REACHED_FROM).find(
    ([p]) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (own) return own[1];
  if (pathname === "/") return "/";
  const tab = TABS.find(
    (t) => t.path !== "/" && (pathname === t.path || pathname.startsWith(`${t.path}/`)),
  );
  return tab?.path ?? null;
}

export const ADD_PATH = "/add";
export const IMPORT_PATH = "/import";
