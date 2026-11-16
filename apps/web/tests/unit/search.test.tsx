/**
 * Search across the app (owner decision, November 16, 2026). It must never go stale and never
 * strand anyone: every screen is in it or has a reason not to be, every result lands where it
 * says, results follow what the person can open, matching is the same every time, and nothing
 * typed leaves the device or is kept.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesFromChildren, MemoryRouter, matchPath, type RouteObject } from "react-router";
import { AppRoutes } from "../../src/app/routes.tsx";
import { ThemeProvider } from "../../src/app/ThemeProvider.tsx";
import { SessionProvider } from "../../src/features/auth/useSession.tsx";
import {
  type Access,
  FREE_ENTITLEMENTS,
  resetEntitlements,
} from "../../src/features/billing/entitlements.ts";
import {
  editDistance,
  PLAN_PATH,
  reachable,
  type SearchContext,
  search,
} from "../../src/features/search/searchEngine.ts";
import { NOT_SEARCHABLE, SEARCH_ENTRIES } from "../../src/features/search/searchIndex.ts";
import { fakeEntitlements, installFakeApi, privateBilling, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";
import { setWideViewport } from "../setup.ts";

const access = (over: Partial<Access>): Access => ({
  state: "subscribed",
  plan: "connected",
  trial_ends_at: null,
  days: null,
  card_from: null,
  delete_at: null,
  trial_used: false,
  shared: null,
  split_guest: false,
  ...over,
});

function ctx(plan: "private" | "connected", over: Partial<Access> = {}, installed = false) {
  return {
    entitlements: {
      ...FREE_ENTITLEMENTS,
      ...(fakeEntitlements(plan) as Partial<typeof FREE_ENTITLEMENTS>),
      access: access({ plan, ...over }),
    },
    installed,
  } satisfies SearchContext;
}

const CONNECTED = ctx("connected");
const labels = (q: string, c: SearchContext = CONNECTED) => search(q, c).map((r) => r.entry.label);

/** Every route the app has, as full paths ("/me/plan", "/goals/:id"). */
function appRoutes(): string[] {
  const out: string[] = [];
  const walk = (routes: RouteObject[], base: string) => {
    for (const r of routes) {
      const here = r.path
        ? r.path === "*"
          ? "*"
          : `${base.replace(/\/$/, "")}/${r.path}`
        : r.index
          ? base || "/"
          : base;
      if ((r.path || r.index) && r.element !== undefined) out.push(here || "/");
      if (r.children) walk(r.children, r.path && r.path !== "*" ? here : base);
    }
  };
  walk(createRoutesFromChildren(AppRoutes().props.children), "");
  return [...new Set(out)];
}

beforeEach(() => {
  resetEntitlements();
  localStorage.clear();
});

describe("search never goes stale", () => {
  it("every screen is either searchable or has a reason not to be", () => {
    const paths = appRoutes();
    expect(paths.length).toBeGreaterThan(60);
    const entryPaths = new Set(SEARCH_ENTRIES.map((e) => e.path.split("?")[0]));
    const missing = paths.filter((p) => !entryPaths.has(p) && !(p in NOT_SEARCHABLE));
    expect(missing).toEqual([]);
    // A reason for a route that no longer exists, or that search opens anyway, is stale too.
    const stale = Object.keys(NOT_SEARCHABLE).filter(
      (p) => !paths.includes(p) || entryPaths.has(p),
    );
    expect(stale).toEqual([]);
  });

  it("ids are unique and every result names where it lives", () => {
    const ids = SEARCH_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of SEARCH_ENTRIES) {
      expect(e.label.trim(), e.id).not.toBe("");
      expect(e.section.trim(), e.id).not.toBe("");
      expect(e.words.trim(), e.id).not.toBe("");
    }
  });

  it("every result's path is a real screen", () => {
    const paths = appRoutes().filter((p) => p !== "*");
    for (const e of SEARCH_ENTRIES) {
      const pathname = e.path.split("?")[0] ?? e.path;
      expect(
        paths.some((p) => matchPath({ path: p, end: true }, pathname)),
        `${e.id} → ${e.path}`,
      ).toBe(true);
    }
  });
});

describe("every result lands where it says", () => {
  const stops = [
    ...new Map(SEARCH_ENTRIES.map((e) => [`${e.path}#${e.target ?? ""}`, e])).values(),
  ];

  it.each(stops.map((e) => [e.id, e] as const))("%s", async (_id, e) => {
    installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected" },
      access: access({}) as unknown as Record<string, unknown>,
    });
    const [pathname, query] = e.path.split("?");
    render(
      <ThemeProvider>
        <SessionProvider>
          <MemoryRouter
            initialEntries={[
              {
                pathname,
                search: query ? `?${query}` : "",
                state: { highlight: e.target ?? null },
              },
            ]}
          >
            <AppRoutes />
          </MemoryRouter>
        </SessionProvider>
      </ThemeProvider>,
    );
    const h1 = await screen.findByRole("heading", { level: 1 }, { timeout: 4000 });
    expect(h1).not.toHaveTextContent("That page isn't here");
    if (e.target)
      await waitFor(() => expect(document.getElementById(e.target ?? "")).not.toBeNull(), {
        timeout: 4000,
      });
  });
});

describe("results follow what the person can open", () => {
  it("a free split-bill guest sees only Splits and Me", () => {
    const guest = ctx("private", { state: "lapsed", split_guest: true });
    const paths = reachable(guest).map((r) => r.path.split("?")[0] ?? "");
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths)
      expect(p === "/splits" || p.startsWith("/splits/") || p.startsWith("/me")).toBe(true);
    expect(labels("budget", guest)).not.toContain("Budget");
    expect(labels("net worth", guest)).toEqual([]);
    expect(labels("venmo", guest)).toContain("How friends pay me");
  });

  it("with no plan to use: only the plans, export and deletion", () => {
    const lapsed = ctx("private", { state: "lapsed" });
    const paths = new Set(reachable(lapsed).map((r) => r.path.split("?")[0]));
    for (const p of paths) expect(["/me/plan", "/me", "/me/data", "/me/delete"]).toContain(p);
    expect(labels("delete", lapsed)).toContain("Delete account");
    expect(labels("export", lapsed)).toContain("Download all my data");
    expect(labels("goals", lapsed)).toEqual([]);
  });

  it("a feature the plan doesn't include says so and opens the plans, never a locked screen", () => {
    const priv = ctx("private");
    const bank = search("link bank", priv).find((r) => r.entry.label === "Linked banks & cards");
    expect(bank).toMatchObject({ locked: true, path: PLAN_PATH });
    const household = search("partner", priv).find((r) => r.entry.label === "Couples & household");
    expect(household).toMatchObject({ locked: true, path: PLAN_PATH });
    const onConnected = search("link bank", CONNECTED).find(
      (r) => r.entry.label === "Linked banks & cards",
    );
    expect(onConnected).toMatchObject({ locked: false, path: "/me/linking" });
  });

  it("installing is offered only in a browser tab", () => {
    expect(labels("install")).toContain("Install Qash");
    expect(labels("install", ctx("connected", {}, true))).not.toContain("Install Qash");
  });
});

describe("matching", () => {
  it("finds features by everyday words", () => {
    expect(labels("how much can i spend")[0]).toBe("Safe to spend");
    expect(labels("netflix")).toContain("Subscriptions");
    expect(labels("owe")).toContain("Split bills");
    expect(labels("debt free")[0]).toBe("Debt payoff");
    expect(labels("logout")[0]).toBe("Log out");
    expect(labels("sign out")[0]).toBe("Log out");
    expect(labels("password")[0]).toBe("Passkeys");
    expect(labels("theme")).toEqual(expect.arrayContaining(["App look", "Dark mode"]));
    expect(labels("refund")[0]).toBe("Your plan");
    expect(labels("how often")[0]).toBe("How often");
    expect(labels("darkmode")[0]).toBe("Dark mode");
    expect(labels("   ")).toEqual([]);
  });

  it("forgives a typo from four letters, never in shorter words", () => {
    expect(labels("budjet")[0]).toBe("Budget");
    expect(labels("subscriptons")).toContain("Subscriptions");
    expect(labels("netwroth")).toContain("Net worth");
    expect(labels("bdg")).toEqual([]);
    expect(editDistance("budjet", "budget")).toBe(1);
    expect(editDistance("teh", "the")).toBe(1);
  });

  it("an exact word always ranks above a typo match", () => {
    const r = search("budget", CONNECTED);
    expect(r[0]?.entry.label).toBe("Budget");
    const exact = r.findIndex((x) => x.entry.words.includes("budget"));
    expect(exact).toBe(0);
  });

  it("is the same every time", () => {
    for (const q of ["bill", "split", "goal", "card", "alert"])
      expect(labels(q)).toEqual(labels(q));
  });
});

describe("the search sheet", () => {
  beforeEach(() => {
    installFakeApi({ session: readySession() });
  });

  it("opens from the header, finds as you type, and opens the result with arrows and Enter", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const box = within(dialog).getByRole("combobox", { name: "Search Qash" });
    expect(box).toHaveFocus();
    // Shortcuts before anything is typed
    expect(within(dialog).getByRole("group", { name: "Shortcuts" })).toBeInTheDocument();
    await user.type(box, "subscr");
    expect(within(dialog).getByRole("status")).toHaveTextContent(/result/);
    const options = within(dialog).getAllByRole("option");
    expect(options[0]).toHaveTextContent("Subscriptions");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", options[0]?.id);
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Subscriptions" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  it("says so when nothing matches, and offers the closest", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    const box = within(dialog).getByRole("combobox");
    await user.type(box, "zzzzqq");
    expect(dialog).toHaveTextContent("Nothing matches “zzzzqq”. Try fewer or other words.");
    await user.clear(box);
    await user.type(box, "subscriptinos");
    expect(within(dialog).getAllByRole("option")[0]).toHaveTextContent("Subscriptions");
  });

  it("⌘K and / open it, but never while typing in a box", async () => {
    const user = userEvent.setup();
    renderApp("/budget");
    await screen.findByRole("heading", { level: 1 });
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    await user.keyboard("/");
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // Typing a slash or ⌘K in a box stays in the box
    renderApp("/me");
    const meBox = await screen.findByRole("searchbox", { name: "Search Qash" });
    await user.type(meBox, "a/b");
    await user.keyboard("{Control>}k{/Control}");
    expect(meBox).toHaveValue("a/b");
    expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull();
  });

  it("keeps nothing typed and sends nothing: Recent is the places opened, cleared on sign out", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Search" }));
    let dialog = await screen.findByRole("dialog", { name: "Search" });
    // The footer says it plainly
    expect(dialog).toHaveTextContent("Search runs only on this device");
    expect(dialog).toHaveTextContent("never sent to Qash or saved");
    expect(within(dialog).getByRole("link", { name: "tell us" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^mailto:support@qash\.solutions/),
    );
    const before = api.calls.length;
    await user.type(within(dialog).getByRole("combobox"), "zebracorn net worth");
    const sent = api.calls
      .slice(before)
      .map((c) => `${c.url} ${c.raw}`)
      .join("\n");
    expect(sent).not.toMatch(/zebracorn/i);
    await user.clear(within(dialog).getByRole("combobox"));
    await user.type(within(dialog).getByRole("combobox"), "net worth");
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { level: 1, name: "Net worth" });
    const stored = Object.entries(localStorage)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    expect(stored).not.toMatch(/zebracorn|net worth/i);
    expect(localStorage.getItem("stackd.search.recent.u1")).toBe('["net-worth"]');

    await user.click(screen.getByRole("button", { name: "Search" }));
    dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog).getByRole("group", { name: "Recent" })).toHaveTextContent("Net worth");
    await user.click(within(dialog).getByRole("button", { name: "Clear Recent" }));
    expect(within(dialog).queryByRole("group", { name: "Recent" })).toBeNull();
    expect(localStorage.getItem("stackd.search.recent.u1")).toBeNull();
  });

  it("signing out forgets Recent", async () => {
    localStorage.setItem("stackd.search.recent.u1", '["budget"]');
    const user = userEvent.setup();
    renderApp("/me");
    await user.click(await screen.findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(localStorage.getItem("stackd.search.recent.u1")).toBeNull());
  });

  it("from 900px it is in the side rail", async () => {
    setWideViewport(true);
    const user = userEvent.setup();
    renderApp("/");
    const rail = await screen.findByRole("complementary");
    await user.click(within(rail).getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeInTheDocument();
    setWideViewport(false);
  });
});
