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

export const ADD_PATH = "/add";
export const IMPORT_PATH = "/import";
