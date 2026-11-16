import "./search.css";

import { Sheet } from "@stackd/ui";
import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { accessRoutes, mayOpen } from "../../app/AccessGate.tsx";
import { useOptionalDb } from "../../data/DbProvider.tsx";
import { formatCents, formatDay } from "../../lib/format.ts";
import { isNativePlatform, isStandalone } from "../../lib/platform.ts";
import { useSession } from "../auth/useSession.tsx";
import { useEntitlements } from "../billing/entitlements.ts";
import { type DataHit, type DataResults, searchData } from "./dataSearch.ts";
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
/** Places shown when the person's own data matches too. */
const SHOWN_WITH_DATA = 3;
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

/** One row in the list: a place in the app, or something of the person's own. */
type Option =
  | { key: string; kind: "place"; result: SearchResult }
  | { key: string; kind: "data"; hit: DataHit };

/** How long typing pauses before the person's own data is searched. */
const DATA_DELAY_MS = 120;

/** The person's own data for what was typed, searched on this device after a short pause. */
function useDataResults(query: string): DataResults | null {
  const device = useOptionalDb();
  const [results, setResults] = useState<DataResults | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!device || q === "") {
      setResults(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void searchData(device.db, q, { money: formatCents, day: (d) => formatDay(d) })
        .then((r) => {
          if (alive) setResults(r);
        })
        .catch(() => {
          if (alive) setResults(null);
        });
    }, DATA_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [device, query]);
  return results;
}

function SearchSheet() {
  const id = useId();
  const ctx = useSearchContext();
  const openResult = useOpenResult();
  const navigate = useNavigate();
  const userId = useSession().info?.user?.id;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState(() => searchRecents(userId));

  const typed = query.trim() !== "";
  const found = useMemo(() => (typed ? search(query, ctx) : []), [typed, query, ctx]);
  const data = useDataResults(query);
  // The person's own things follow the same access table: a guest or an ended plan never gets
  // a result that leads somewhere they can't open.
  const routes = accessRoutes(ctx.entitlements.access);
  const dataSections = (data?.sections ?? [])
    .map((sec) => ({
      ...sec,
      hits: sec.hits.filter((h) => !routes || mayOpen(routes, h.path)),
      all: sec.all && (!routes || mayOpen(routes, sec.all.path)) ? sec.all : undefined,
    }))
    .filter((sec) => sec.hits.length);
  const dataCount = dataSections.reduce((n, sec) => n + sec.hits.length, 0);
  const near = useMemo(
    () => (typed && found.length === 0 ? closest(query, ctx) : []),
    [typed, found, query, ctx],
  );
  const all = useMemo(() => reachable(ctx), [ctx]);
  const byId = (ids: readonly string[]) =>
    ids.map((i) => all.find((r) => r.entry.id === i)).filter((r): r is SearchResult => !!r);
  const place = (r: SearchResult): Option => ({ key: r.entry.id, kind: "place", result: r });
  const own = (h: DataHit): Option => ({ key: h.key, kind: "data", hit: h });

  const groups: { label: string; items: Option[]; more?: number }[] = typed
    ? [
        ...(found.length
          ? [
              {
                label: "In Qash",
                // With the person's own matches below, the best few places, so theirs show too.
                items: found.slice(0, dataCount ? SHOWN_WITH_DATA : SHOWN).map(place),
                more: found.length - Math.min(found.length, dataCount ? SHOWN_WITH_DATA : SHOWN),
              },
            ]
          : near.length && dataCount === 0
            ? [{ label: "Did you mean", items: near.map(place) }]
            : []),
        ...dataSections.map((sec) => ({
          label: sec.title,
          items: [...sec.hits.map(own), ...(sec.all ? [own(sec.all)] : [])],
          more: sec.all ? 0 : sec.more,
        })),
      ]
    : [
        { label: "Recent", items: byId(recents).map(place) },
        {
          label: "Shortcuts",
          items: byId(SHORTCUT_IDS.filter((s) => !recents.includes(s))).map(place),
        },
      ].filter((g) => g.items.length);
  const items = groups.flatMap((g) => g.items);
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (i: number) => `${id}-opt-${i}`;

  function pick(o: Option) {
    closeSearch();
    // A place is remembered for Recent; the person's own things never are.
    if (o.kind === "place") openResult(o.result);
    else navigate(o.hit.path, { state: o.hit.state ?? null });
  }

  const total = found.length + dataCount;
  const status = !typed
    ? ""
    : total
      ? `${total} ${total === 1 ? "result" : "results"}`
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
          placeholder="A screen, setting, merchant or amount"
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
            const at = items[current];
            if (e.key === "ArrowDown" && items.length) {
              e.preventDefault();
              setActive((current + 1) % items.length);
            } else if (e.key === "ArrowUp" && items.length) {
              e.preventDefault();
              setActive((current - 1 + items.length) % items.length);
            } else if (e.key === "Enter" && at) {
              e.preventDefault();
              pick(at);
            }
          }}
        />
      </search>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {typed && !found.length && !dataCount ? (
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
              {g.more ? <span> · {g.more} more</span> : null}
            </div>
            {g.items.map((o) => {
              n += 1;
              const i = n;
              return (
                <div
                  key={o.key}
                  id={optionId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === current}
                  className="search-sheet__option"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(o)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") pick(o);
                  }}
                >
                  {o.kind === "place" ? (
                    <>
                      <span className="search-sheet__label">{o.result.entry.label}</span>
                      <span className="search-sheet__where">
                        {o.result.entry.section}
                        {o.result.entry.line ? ` · ${o.result.entry.line}` : ""}
                      </span>
                      {o.result.locked ? (
                        <span className="search-sheet__tag">Not on your plan · See plans</span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <span className="search-sheet__label">{o.hit.label}</span>
                      <span className="search-sheet__where">{o.hit.detail}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <footer className="search-sheet__privacy">
        <p>
          <strong>Private by design.</strong> Search runs only on this device, over the app and your
          own entries, jars and bills here. What you type is never sent to Qash or saved. Recent
          keeps only the screens you opened, here, until you clear it or sign out.
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
