import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { activeTab } from "../../src/app/tabs.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";
import { setViewportWidth, setWideViewport } from "../setup.ts";

beforeEach(() => {
  installFakeApi({ session: readySession() });
});

async function renderAt(path: string) {
  const result = renderApp(path);
  await screen.findByRole("navigation", { name: "Primary" });
  return result;
}

describe("App shell on a phone", () => {
  it("has a skip link, one primary nav with the five tabs, and marks the current one", async () => {
    await renderAt("/");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("tabbar");
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Budget", "Goals", "Insights", "Me"]);
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Budget" })).not.toHaveAttribute("aria-current");
  });

  it("lights the tab a screen is reached from: Insights for What if and its siblings", async () => {
    expect(activeTab("/what-if")).toBe("/insights");
    expect(activeTab("/month-review")).toBe("/insights");
    expect(activeTab("/credit-habits")).toBe("/insights");
    expect(activeTab("/insights/fixed-flexible")).toBe("/insights");
    expect(activeTab("/goals/g1")).toBe("/goals");
    expect(activeTab("/")).toBe("/");
    // Subscriptions (from Bills) lights no tab, as before; nor does a look-alike prefix.
    expect(activeTab("/subscriptions")).toBeNull();
    expect(activeTab("/what-iffy")).toBeNull();
    for (const path of ["/what-if", "/month-review", "/credit-habits"]) {
      const view = await renderAt(path);
      const nav = screen.getByRole("navigation", { name: "Primary" });
      expect(within(nav).getByRole("link", { name: "Insights" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(within(nav).getByRole("link", { name: "Budget" })).not.toHaveAttribute("aria-current");
      view.unmount();
    }
    setWideViewport(true);
    await renderAt("/what-if");
    const rail = screen.getByRole("navigation", { name: "Primary" });
    expect(rail.className).toContain("rail");
    expect(within(rail).getByRole("link", { name: "Insights" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("moves between tabs, updates the title, and focuses main", async () => {
    const user = userEvent.setup();
    await renderAt("/");
    expect(document.title).toMatch(/^Good (morning|afternoon|evening) · Qash$/);
    await user.click(screen.getByRole("link", { name: "Budget" }));
    expect(screen.getByRole("heading", { level: 1, name: "Budget" })).toBeInTheDocument();
    expect(document.title).toBe("Budget · Qash");
    expect(screen.getByRole("link", { name: "Budget" })).toHaveAttribute("aria-current", "page");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("the global + button leads to the add screen", async () => {
    const user = userEvent.setup();
    await renderAt("/");
    await user.click(screen.getByRole("button", { name: "Add entry or receipt" }));
    await user.click(await screen.findByRole("button", { name: /An entry/ }));
    expect(screen.getByRole("heading", { level: 1, name: "Add entry" })).toBeInTheDocument();
  });

  it("unknown paths get a way home", async () => {
    await renderAt("/nope");
    expect(
      screen.getByRole("heading", { level: 1, name: "That page isn't here" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Home" })).toBeInTheDocument();
  });
});

describe("App shell below 900px", () => {
  it("keeps the tab bar on a narrow window or a tablet in portrait", async () => {
    setViewportWidth(820);
    await renderAt("/goals");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("tabbar");
    expect(document.querySelector(".rail")).toBeNull();
  });
});

describe("App shell at 900px and up", () => {
  it("shows the side rail instead of the tab bar, with the brand and the same tabs", async () => {
    setWideViewport(true);
    await renderAt("/goals");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("rail__nav");
    expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull();
    expect(within(nav).getAllByRole("link")).toHaveLength(5);
    expect(within(nav).getByRole("link", { name: "Goals" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Qash")).toBeInTheDocument();
  });

  it("clicking who is signed in opens Your account and Log out", async () => {
    setWideViewport(true);
    await renderAt("/goals");
    const rail = document.querySelector(".rail") as HTMLElement;
    expect(within(rail).queryByRole("button", { name: "Log out" })).toBeNull();
    const who = within(rail).getByRole("button", { expanded: false });
    await userEvent.click(who);
    expect(who).toHaveAttribute("aria-expanded", "true");
    expect(within(rail).getByRole("link", { name: "Your account" })).toHaveAttribute("href", "/me");
    await userEvent.keyboard("{Escape}");
    expect(within(rail).queryByRole("button", { name: "Log out" })).toBeNull();
    await userEvent.click(who);
    await userEvent.click(within(rail).getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(document.querySelector(".rail")).toBeNull();
  });
});

describe("Display settings on Me", () => {
  it("switches Simple layout and dark mode instantly, honouring Match system", async () => {
    const user = userEvent.setup();
    await renderAt("/me/look");
    const html = document.documentElement;
    const simple = screen.getByRole("switch", { name: "Simple layout" });
    const dark = screen.getByRole("switch", { name: "Dark mode" });
    const system = screen.getByRole("switch", { name: "Match system" });

    expect(system).toBeChecked();
    expect(dark).toBeDisabled();

    await user.click(simple);
    expect(html.getAttribute("data-simple")).toBe("1");

    await user.click(system);
    expect(dark).toBeEnabled();
    expect(html.getAttribute("data-mode")).toBe("light");

    await user.click(dark);
    expect(dark).toBeChecked();
    expect(html.getAttribute("data-mode")).toBe("dark");
    // Six looks on the web (owner decision, October 12, 2026), each a preview tile.
    expect(screen.getByRole("radio", { name: "Retro 80s" })).toBeInTheDocument();
  });
});

describe("Desktop two-pane layout at 900px and up (fast-follow 5)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T09:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Goals shows jars and challenges side by side, with no tab switch", async () => {
    setViewportWidth(1024);
    await renderAt("/goals");
    expect(screen.getByRole("navigation", { name: "Primary" }).className).toContain("rail__nav");
    expect(screen.queryByRole("radio", { name: "Challenges" })).toBeNull();
    expect(screen.getByRole("region", { name: /Jars · 0/ })).toBeInTheDocument();
    const challenges = screen.getByRole("region", { name: "Challenges" });
    expect(await within(challenges).findByText(/No challenges yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a challenge" })).toBeInTheDocument();
  });

  it("Home greets by name with the date and keeps recent entries in the side pane; tablets stay one column", async () => {
    setViewportWidth(1024);
    installFakeApi({
      session: readySession({
        user: { id: "u1", email: "maya@example.com", display_name: "Maya R.", look: "modern" },
      }),
    });
    const { container } = renderApp("/");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Good morning, Maya" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Saturday, October 10")).toBeInTheDocument();
    const side = container.querySelector(".pane--side");
    expect(side).not.toBeNull();
    expect(
      await within(side as HTMLElement).findByRole("heading", { name: "Recent entries" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".two-pane .pane--main")).not.toBeNull();
    expect(screen.getByText("Qash")).toBeInTheDocument();
    expect(screen.getByText("Maya R.")).toBeInTheDocument(); // the rail's signed-in footer

    // 600–899px: the rail but one column (the tab switch is back on Goals)
    setViewportWidth(700);
    renderApp("/goals");
    expect(await screen.findByRole("radio", { name: "Challenges" })).toBeInTheDocument();
  });
});
