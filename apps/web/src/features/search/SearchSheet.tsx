import "./search.css";

import { Sheet } from "@stackd/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { isNativePlatform, isStandalone } from "../../lib/platform.ts";
import { useSession } from "../auth/useSession.tsx";
import { useEntitlements } from "../billing/entitlements.ts";
import { clearSearchRecents, rememberSearchPick, searchRecents } from "./recents.ts";
import {
  closest,
  reachable,
  type SearchContext,
  type SearchResult,
  search,
} from "./searchEngine.ts";
import { SHORTCUT_IDS } from "./searchIndex.ts";
import { closeSearch, openSearch, useSearchOpen } from "./searchOpen.ts";

/** Results shown at most; the first ones are the best by the engine's order. */
const SHOWN = 8;
export const SUPPORT_EMAIL = "support@qash.solutions";

/** What this person may see in search: their plan's access and the platform. */
export function useSearchContext(): SearchContext {
  const { entitlements } = useEntitlements();
  return useMemo(
    () => ({ entitlements, installed: isStandalone() || isNativePlatform() }),
    [entitlements],
  );
}

/** Opens a result: its screen (or the plans), then the row it names is flashed there. */
export function useOpenResult() {
  const navigate = useNavigate();
  const userId = useSession().info?.user?.id;
  return (r: SearchResult) => {
    rememberSearchPick(userId, r.entry.id);
    navigate(r.path, { state: { highlight: r.locked ? null : (r.entry.target ?? null) } });
  };
}

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Mounted once in the app's frame. ⌘K / Ctrl+K and "/" open search from anywhere, except while
 * typing in a box or with another sheet open, so a shortcut never takes over what someone is doing.
 */
export function SearchHost() {
  const open = useSearchOpen();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || editable(e.target) || document.querySelector('[aria-modal="true"]')) return;
      const shortcut =
        ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") ||
        (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey);
      if (!shortcut) return;
      e.preventDefault();
      openSearch();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  // Leaving the app's frame (signing out, the lock screen) closes it.
  useEffect(() => closeSearch, []);
  return open ? <SearchSheet /> : null;
}

function SearchSheet() {
  const id = useId();
  const ctx = useSearchContext();
  const openResult = useOpenResult();
  const userId = useSession().info?.user?.id;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState(() => searchRecents(userId));

  const typed = query.trim() !== "";
  const found = useMemo(() => (typed ? search(query, ctx) : []), [typed, query, ctx]);
  const near = useMemo(
    () => (typed && found.length === 0 ? closest(query, ctx) : []),
    [typed, found, query, ctx],
  );
  const all = useMemo(() => reachable(ctx), [ctx]);
  const byId = (ids: readonly string[]) =>
    ids.map((i) => all.find((r) => r.entry.id === i)).filter((r): r is SearchResult => !!r);
  const groups: { label: string; items: SearchResult[] }[] = typed
    ? found.length
      ? [{ label: "Results", items: found.slice(0, SHOWN) }]
      : near.length
        ? [{ label: "Did you mean", items: near }]
        : []
    : [
        { label: "Recent", items: byId(recents) },
        { label: "Shortcuts", items: byId(SHORTCUT_IDS.filter((s) => !recents.includes(s))) },
      ].filter((g) => g.items.length);
  const items = groups.flatMap((g) => g.items);
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (i: number) => `${id}-opt-${i}`;

  function pick(r: SearchResult) {
    closeSearch();
    openResult(r);
  }

  const status = !typed
    ? ""
    : found.length
      ? `${found.length} ${found.length === 1 ? "result" : "results"}`
      : near.length
        ? `Nothing matches. ${near.length} close ${near.length === 1 ? "match" : "matches"}`
        : "Nothing matches";

  let n = -1;
  return (
    <Sheet open onClose={closeSearch} title="Search" className="search-sheet">
      <search className="settings-search">
        <label htmlFor={`${id}-q`} className="sr-only">
          Search Qash
        </label>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          id={`${id}-q`}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={items.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={items.length ? optionId(current) : undefined}
          className="settings-search__input"
          placeholder="Search for a screen, setting or action"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && items.length) {
              e.preventDefault();
              setActive((current + 1) % items.length);
            } else if (e.key === "ArrowUp" && items.length) {
              e.preventDefault();
              setActive((current - 1 + items.length) % items.length);
            } else if (e.key === "Enter" && items[current]) {
              e.preventDefault();
              pick(items[current]);
            }
          }}
        />
      </search>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {typed && !found.length ? (
        <p className="search-sheet__none">
          Nothing matches “{query.trim()}”.{near.length ? "" : " Try fewer or other words."}
        </p>
      ) : null}
      {!typed && recents.length ? (
        <button
          type="button"
          className="search-sheet__clear"
          onClick={() => {
            clearSearchRecents(userId);
            setRecents([]);
          }}
        >
          Clear Recent
        </button>
      ) : null}
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Search results"
        className="search-sheet__list"
      >
        {groups.map((g) => (
          // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox, not a form's fieldset
          <div key={g.label} role="group" aria-label={g.label} className="search-sheet__group">
            <div className="search-sheet__group-head" aria-hidden="true">
              {g.label}
            </div>
            {g.items.map((r) => {
              n += 1;
              const i = n;
              return (
                <div
                  key={r.entry.id}
                  id={optionId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === current}
                  className="search-sheet__option"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") pick(r);
                  }}
                >
                  <span className="search-sheet__label">{r.entry.label}</span>
                  <span className="search-sheet__where">
                    {r.entry.section}
                    {r.entry.line ? ` · ${r.entry.line}` : ""}
                  </span>
                  {r.locked ? (
                    <span className="search-sheet__tag">Not on your plan · See plans</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <footer className="search-sheet__privacy">
        <p>
          <strong>Private by design.</strong> Search runs only on this device. What you type is
          never sent to Qash or saved. Recent keeps only the places you opened, here, until you
          clear it or sign out.
        </p>
        <p>
          Because we never see your searches, we can't tell when something is hard to find. If you
          can't find it,{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Couldn't find in Qash")}`}
          >
            tell us
          </a>{" "}
          what you looked for.
        </p>
      </footer>
    </Sheet>
  );
}

/** The search button: round, beside Me on phones; in the rail from 900px. */
export function SearchButton({ variant = "round" }: { variant?: "round" | "rail" }) {
  if (variant === "rail")
    return (
      <button type="button" className="rail__search" aria-label="Search" onClick={openSearch}>
        <SearchIcon />
        <span>Search</span>
        <kbd className="rail__kbd">
          {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>
    );
  return (
    <button type="button" className="search-btn" aria-label="Search" onClick={openSearch}>
      <SearchIcon />
    </button>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
