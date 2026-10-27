import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { STORAGE_KEYS, ThemeProvider, useTheme } from "../../src/app/ThemeProvider.tsx";
import { setSystemDark } from "../setup.ts";

const fontsLoaded = vi.hoisted(() => vi.fn(async (_look: string) => {}));
vi.mock("../../src/app/lookFonts.ts", () => ({ loadLookFonts: fontsLoaded }));

function fakeNative(on: boolean) {
  (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => on };
}

function Probe() {
  const t = useTheme();
  return (
    <div>
      <output data-testid="state">
        {`${t.look}|${t.availableLooks.join(",")}|${t.mode}|${t.resolvedMode}|${t.simpleLayout}`}
      </output>
      <button type="button" onClick={() => t.setMode("dark")}>
        dark
      </button>
      <button type="button" onClick={() => t.setMode("light")}>
        light
      </button>
      <button type="button" onClick={() => t.setMode("system")}>
        system
      </button>
      <button type="button" onClick={() => t.setSimpleLayout(!t.simpleLayout)}>
        simple
      </button>
      <button type="button" onClick={() => t.setLook("anime")}>
        anime
      </button>
      <button type="button" onClick={() => t.adoptSavedLook("pastel")}>
        adopt pastel
      </button>
      <button type="button" onClick={() => t.setLook("retro")}>
        retro
      </button>
      <button type="button" onClick={() => t.adoptSavedLook("retro")}>
        adopt retro
      </button>
    </div>
  );
}

const html = () => document.documentElement;

describe("ThemeProvider", () => {
  it("defaults to Modern, Match system (light here), full layout", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent(
      "modern|modern,minimal,retro,pastel,anime,illustrative|system|light|false",
    );
    expect(html().getAttribute("data-look")).toBe("modern");
    expect(html().hasAttribute("data-mode")).toBe(false); // CSS follows prefers-color-scheme
    expect(html().getAttribute("data-simple")).toBe("0");
  });

  it("follows the system while mode is system, instantly", () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => setSystemDark(true));
    expect(screen.getByTestId("state")).toHaveTextContent("|system|dark|");
    expect(html().hasAttribute("data-mode")).toBe(false);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#0B0D12",
    );
  });

  it("explicit dark and light set data-mode and persist; system clears it", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole("button", { name: "dark" }));
    expect(html().getAttribute("data-mode")).toBe("dark");
    expect(localStorage.getItem(STORAGE_KEYS.mode)).toBe("dark");
    await user.click(screen.getByRole("button", { name: "light" }));
    expect(html().getAttribute("data-mode")).toBe("light");
    await user.click(screen.getByRole("button", { name: "system" }));
    expect(html().hasAttribute("data-mode")).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.mode)).toBeNull();
  });

  it("restores a saved choice on start", () => {
    localStorage.setItem(STORAGE_KEYS.mode, "dark");
    localStorage.setItem(STORAGE_KEYS.simple, "1");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("|dark|dark|true");
    expect(html().getAttribute("data-simple")).toBe("1");
  });

  it("toggles Simple layout and persists it", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole("button", { name: "simple" }));
    expect(html().getAttribute("data-simple")).toBe("1");
    expect(localStorage.getItem(STORAGE_KEYS.simple)).toBe("1");
  });

  describe("looks (chunk 2.2)", () => {
    afterEach(() => {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
      fontsLoaded.mockClear();
    });

    it("in a native app: three looks, a switch applies at once, loads its fonts and is remembered", async () => {
      const user = userEvent.setup();
      fakeNative(true);
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      expect(screen.getByTestId("state")).toHaveTextContent("modern|modern,pastel,anime|");
      await user.click(screen.getByRole("button", { name: "anime" }));
      expect(html().getAttribute("data-look")).toBe("anime");
      expect(localStorage.getItem(STORAGE_KEYS.look)).toBe("anime");
      expect(fontsLoaded).toHaveBeenLastCalledWith("anime");
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        "#FDF1DC",
      );
      await user.click(screen.getByRole("button", { name: "adopt pastel" }));
      expect(html().getAttribute("data-look")).toBe("pastel");
      expect(fontsLoaded).toHaveBeenLastCalledWith("pastel");
    });

    it("in a native app: starts from the remembered look before the session arrives", () => {
      fakeNative(true);
      localStorage.setItem(STORAGE_KEYS.look, "pastel");
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      expect(html().getAttribute("data-look")).toBe("pastel");
    });

    it("in the PWA: all six looks; a switch applies, is remembered and loads its fonts", async () => {
      const user = userEvent.setup();
      fakeNative(false);
      localStorage.setItem(STORAGE_KEYS.look, "anime");
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      expect(screen.getByTestId("state")).toHaveTextContent(
        "anime|modern,minimal,retro,pastel,anime,illustrative|",
      );
      await user.click(screen.getByRole("button", { name: "retro" }));
      expect(html().getAttribute("data-look")).toBe("retro");
      expect(localStorage.getItem(STORAGE_KEYS.look)).toBe("retro");
      expect(fontsLoaded).toHaveBeenLastCalledWith("retro");
    });

    it("in a native app: a web-only look saved on the account shows Modern", async () => {
      const user = userEvent.setup();
      fakeNative(true);
      render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      );
      await user.click(screen.getByRole("button", { name: "adopt retro" }));
      expect(html().getAttribute("data-look")).toBe("modern");
      await user.click(screen.getByRole("button", { name: "retro" })); // not offered here
      expect(html().getAttribute("data-look")).toBe("modern");
    });
  });
});
