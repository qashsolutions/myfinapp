import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { DEFAULT_ORDER, moveCard, normalizeLayout } from "../../src/features/home/homeLayout.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

/** The h2 titles of Home's main pane, top to bottom. */
function cardTitles(): string[] {
  const main = document.querySelector(".pane--main");
  return [...(main?.querySelectorAll("h2") ?? [])].map((h) => h.textContent ?? "");
}

describe("Customize Home (owner decision, October 19, 2026)", () => {
  it("moves a card up and switches one off, and Home follows at once", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Customize Home" }));
    const sheet = await screen.findByRole("dialog", { name: "Customize Home" });
    const before = cardTitles();
    expect(before.indexOf("Next 30 days")).toBeGreaterThan(-1);

    // Next 30 days up to the top: it is 6th, five moves up
    for (let i = 0; i < 5; i++)
      await user.click(within(sheet).getByRole("button", { name: "Move Next 30 days up" }));
    expect(within(sheet).getByRole("status")).toHaveTextContent("Next 30 days moved to 1 of 11");

    // Switch "Make Qash yours" off
    await user.click(within(sheet).getByRole("switch", { name: /Make Qash yours/ }));
    await user.click(within(sheet).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(cardTitles()[0]).toBe("Next 30 days"));
    expect(cardTitles().some((t) => t.startsWith("Make Qash yours"))).toBe(false);
    const saved = (await db.settings.get("home.layout"))?.value as {
      order: string[];
      hidden: string[];
    };
    expect(saved.order[0]).toBe("next30");
    expect(saved.hidden).toEqual(["setup"]);
  });

  it("Recent entries can be switched off, and Reset brings everything back", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.settings.put({
      key: "home.layout",
      value: { order: DEFAULT_ORDER, hidden: ["recent", "setup"] },
      updated_at: "2026-10-19T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("button", { name: "Customize Home" });
    expect(screen.queryByRole("heading", { name: "Recent entries" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Customize Home" }));
    await user.click(await screen.findByRole("button", { name: "Reset to the usual order" }));
    expect(await screen.findByRole("heading", { name: "Recent entries" })).toBeInTheDocument();
  });

  it("the layout heals: unknown cards dropped, new ones appended, no repeats", () => {
    expect(normalizeLayout(undefined).order).toEqual(DEFAULT_ORDER);
    const healed = normalizeLayout({
      order: ["jars", "bogus", "jars", "kept"],
      hidden: ["x", "kept"],
    });
    expect(healed.order.slice(0, 2)).toEqual(["jars", "kept"]);
    expect(healed.order).toHaveLength(DEFAULT_ORDER.length);
    expect(healed.hidden).toEqual(["kept"]);
    expect(moveCard(["a", "b", "c"] as never[], 2, 0)).toEqual(["c", "a", "b"]);
  });
});
