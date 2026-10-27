/**
 * Look, mode and Simple layout for the whole app (docs/spec.md "Theme system").
 *
 * Looks (owner decision, October 12, 2026): the web offers all six, the native apps three
 * (NATIVE_LOOKS). The look is the device's cached choice for the first paint, then the
 * account's value when the session arrives (LookSync); a switch applies at once while the
 * look's fonts load (lookFonts.ts), and Settings saves it to the account. A native app given a
 * web-only look (Retro 80s, say) shows Modern and leaves the saved value alone, so switching
 * devices never undoes a choice. Mode is "light", "dark" or "system" (default; "Match system");
 * Simple layout is off by default. Both are persisted on the device.
 *
 * Colours come from CSS: this provider only sets data-look / data-mode / data-simple on
 * <html>. With "system" the data-mode attribute is removed so tokens.css's
 * prefers-color-scheme fallback decides, which keeps the switch instant and flash-free.
 */

import { LOOKS as ALL_LOOKS, type Look, type Mode, NATIVE_LOOKS, themeVars } from "@stackd/tokens";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { isNativePlatform } from "../lib/platform.ts";
import { loadLookFonts } from "./lookFonts.ts";

export type ModeSetting = Mode | "system";

export interface Theme {
  look: Look;
  availableLooks: readonly Look[];
  /** The setting: light, dark or system. */
  mode: ModeSetting;
  /** What is on screen right now. */
  resolvedMode: Mode;
  simpleLayout: boolean;
  setMode: (mode: ModeSetting) => void;
  setSimpleLayout: (on: boolean) => void;
  /** Switches the look on this device (one of availableLooks). */
  setLook: (look: Look) => void;
  /** Applies the account's saved look; one this platform does not offer shows Modern. */
  adoptSavedLook: (look: string | null | undefined) => void;
}

export const STORAGE_KEYS = {
  mode: "stackd.mode",
  simple: "stackd.simple",
  look: "stackd.look",
} as const;
export const LOOKS: readonly Look[] = ALL_LOOKS;
export const LOOK_NAMES: Record<Look, string> = {
  modern: "Modern",
  minimal: "Minimal",
  retro: "Retro 80s",
  pastel: "Pastel",
  anime: "Anime",
  illustrative: "Illustrative",
};

export function looksFor(native: boolean): readonly Look[] {
  return native ? NATIVE_LOOKS : ALL_LOOKS;
}
const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<Theme | null>(null);

function isLook(value: unknown): value is Look {
  return typeof value === "string" && (LOOKS as readonly string[]).includes(value);
}

function readLook(native: boolean): Look {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.look);
    return isLook(v) && looksFor(native).includes(v) ? v : "modern";
  } catch {
    return "modern";
  }
}

function rememberLook(look: Look): void {
  try {
    localStorage.setItem(STORAGE_KEYS.look, look);
  } catch {
    /* private mode or storage blocked: the choice still applies for this session */
  }
}

function readMode(): ModeSetting {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.mode);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function readSimple(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEYS.simple) === "1";
  } catch {
    return false;
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.(DARK_QUERY).matches ?? false);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const native = useMemo(() => isNativePlatform(), []);
  const availableLooks = useMemo<readonly Look[]>(() => looksFor(native), [native]);
  const [look, setLookState] = useState<Look>(() => readLook(native));
  const [mode, setModeState] = useState<ModeSetting>(readMode);
  const [simpleLayout, setSimpleState] = useState<boolean>(readSimple);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia?.(DARK_QUERY);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedMode: Mode = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-look", look);
    if (mode === "system") html.removeAttribute("data-mode");
    else html.setAttribute("data-mode", mode);
    html.setAttribute("data-simple", simpleLayout ? "1" : "0");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", themeVars(look, resolvedMode)["--c-bg"]);
  }, [look, mode, simpleLayout, resolvedMode]);

  useEffect(() => {
    void loadLookFonts(look);
  }, [look]);

  const setLook = useCallback(
    (next: Look) => {
      if (!isLook(next) || !availableLooks.includes(next)) return;
      setLookState(next);
      rememberLook(next);
    },
    [availableLooks],
  );

  const adoptSavedLook = useCallback(
    (saved: string | null | undefined) => {
      if (!isLook(saved)) return;
      // A look this platform doesn't offer shows Modern here; the account keeps the choice.
      const shown = availableLooks.includes(saved) ? saved : "modern";
      setLookState(shown);
      rememberLook(shown);
    },
    [availableLooks],
  );

  const setMode = useCallback((next: ModeSetting) => {
    setModeState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEYS.mode);
      else localStorage.setItem(STORAGE_KEYS.mode, next);
    } catch {
      /* private mode or storage blocked: the choice still applies for this session */
    }
  }, []);

  const setSimpleLayout = useCallback((on: boolean) => {
    setSimpleState(on);
    try {
      localStorage.setItem(STORAGE_KEYS.simple, on ? "1" : "0");
    } catch {
      /* same as above */
    }
  }, []);

  const value = useMemo<Theme>(
    () => ({
      look,
      availableLooks,
      mode,
      resolvedMode,
      simpleLayout,
      setMode,
      setSimpleLayout,
      setLook,
      adoptSavedLook,
    }),
    [
      look,
      availableLooks,
      mode,
      resolvedMode,
      simpleLayout,
      setMode,
      setSimpleLayout,
      setLook,
      adoptSavedLook,
    ],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
