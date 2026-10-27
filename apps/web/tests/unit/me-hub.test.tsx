import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { searchSettings } from "../../src/features/settings/settingsIndex.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";
import { setWideViewport } from "../setup.ts";

beforeEach(() => {
  installFakeApi({ session: readySession() });
});

describe("Me: the hub, its groups and search", () => {
  it("lists the groups, with Log out and Delete account two taps from Me", async () => {
    renderApp("/me");
    const groups = await screen.findByRole("list", { name: "Settings groups" });
    expect(
      within(groups)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/me/security",
      "/me/data",
      "/me/notifications",
      "/me/groups",
      "/me/look",
      "/me/help",
    ]);
    const account = screen.getByRole("region", { name: "Account" });
    expect(within(account).getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(within(account).getByRole("button", { name: "Delete account" })).toBeInTheDocument();
  });

  it("finds settings by everyday words", () => {
    expect(searchSettings("logout")[0]?.label).toBe("Log out");
    expect(searchSettings("sign out")[0]?.label).toBe("Log out");
    expect(searchSettings("password")[0]?.label).toBe("Passkeys");
    expect(searchSettings("theme").map((e) => e.label)).toEqual(
      expect.arrayContaining(["App look", "Dark mode"]),
    );
    expect(searchSettings("refund")[0]?.label).toBe("Your plan");
    expect(searchSettings("how often")[0]?.label).toBe("How often");
    expect(searchSettings("   ")).toEqual([]);
  });

  it("search replaces the groups, opens the setting and highlights it", async () => {
    const user = userEvent.setup();
    renderApp("/me");
    const box = await screen.findByRole("searchbox", { name: "Search settings" });
    await user.type(box, "zzzz");
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches “zzzz”");
    await user.clear(box);
    await user.type(box, "dark");
    const results = screen.getByRole("list", { name: "Search results" });
    expect(screen.queryByRole("list", { name: "Settings groups" })).toBeNull();
    const dark = within(results).getByRole("link", { name: /Dark mode/ });
    expect(dark).toHaveTextContent("Look & feel");
    await user.click(dark);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Look & feel" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.getElementById("set-display")).toHaveClass("settings-flash"),
    );
  });

  it("Alerts: each type shows when it comes, with its choices only while it is on", async () => {
    const user = userEvent.setup();
    renderApp("/me/notifications");
    const list = await screen.findByRole("list", { name: "Alert types" });
    const recap = within(list).getByText("Weekly recap").closest("li") as HTMLElement;
    expect(within(recap).getByRole("group", { name: "Weekly recap options" })).toBeInTheDocument();
    await user.click(within(recap).getByRole("switch", { name: "Weekly recap alerts" }));
    await waitFor(() =>
      expect(within(recap).queryByRole("group", { name: "Weekly recap options" })).toBeNull(),
    );
    expect(recap).toHaveTextContent("Off");
    expect(screen.getByRole("heading", { level: 2, name: "How often" })).toBeInTheDocument();
  });
});

describe("Me at 900px and up", () => {
  it("a group's screen sits beside every group, the open one marked", async () => {
    setWideViewport(true);
    renderApp("/me/look");
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Look & feel" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("searchbox", { name: "Search settings" })).toBeInTheDocument();
  });

  it("the hub itself stays one column", async () => {
    setWideViewport(true);
    renderApp("/me");
    await screen.findByRole("list", { name: "Settings groups" });
    expect(screen.queryByRole("navigation", { name: "Settings" })).toBeNull();
  });
});
