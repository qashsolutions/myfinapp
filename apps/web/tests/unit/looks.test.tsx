import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { STORAGE_KEYS } from "../../src/app/ThemeProvider.tsx";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

vi.mock("../../src/app/lookFonts.ts", () => ({ loadLookFonts: vi.fn(async () => {}) }));

/** Looks (owner decision, October 12, 2026): six on the web, three in the native apps; the account keeps the choice. */
describe("App look", () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("native: adopts the account's look, switches instantly and saves the choice to the account", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const user = userEvent.setup();
    const api = installFakeApi({
      session: readySession({
        user: { id: "u1", email: "maya.r@example.com", display_name: null, look: "pastel" },
      }),
    });
    renderApp("/me/look");
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(document.documentElement.getAttribute("data-look")).toBe("pastel"));
    const card = screen.getByRole("region", { name: "App look" });
    expect(within(card).getByRole("radio", { name: "Pastel" })).toBeChecked();
    await user.click(within(card).getByRole("radio", { name: "Anime" }));
    expect(document.documentElement.getAttribute("data-look")).toBe("anime");
    expect(localStorage.getItem(STORAGE_KEYS.look)).toBe("anime");
    await waitFor(() =>
      expect(
        api.calls.find((c) => c.method === "PATCH" && c.path === "/api/account")?.body,
      ).toEqual({ look: "anime" }),
    );
    expect(card).toHaveTextContent("Same screens and wording in every look");
    expect(card).toHaveTextContent("Minimal, Retro 80s and Illustrative are in the web app too.");
    expect(within(card).queryByRole("radio", { name: "Retro 80s" })).toBeNull();
  });

  it("web: all six looks as preview tiles; the account's look applies and a pick is saved", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({
      session: readySession({
        user: { id: "u1", email: "maya.r@example.com", display_name: null, look: "anime" },
      }),
    });
    renderApp("/me/look");
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(() => expect(document.documentElement.getAttribute("data-look")).toBe("anime"));
    const card = await screen.findByRole("region", { name: "App look" });
    const radios = within(card).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual([
      "modern",
      "minimal",
      "retro",
      "pastel",
      "anime",
      "illustrative",
    ]);
    // Each tile is painted by its own look.
    const tile = within(card).getByRole("radio", { name: "Illustrative" }).closest("label");
    expect(tile?.getAttribute("data-look")).toBe("illustrative");
    await user.click(within(card).getByRole("radio", { name: "Illustrative" }));
    expect(document.documentElement.getAttribute("data-look")).toBe("illustrative");
    await waitFor(() =>
      expect(
        api.calls.find((c) => c.method === "PATCH" && c.path === "/api/account")?.body,
      ).toEqual({ look: "illustrative" }),
    );
    expect(card).not.toHaveTextContent("are in the web app too");
  });
});
