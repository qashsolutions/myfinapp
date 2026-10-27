import { cx, List, ListRow } from "@stackd/ui";
import { type ReactNode, useId, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import { GROUPS, groupTitle, type SettingEntry, searchSettings } from "./settingsIndex.ts";

/** Opens a setting: its screen, then the row is scrolled to and briefly highlighted. */
export function useOpenSetting() {
  const navigate = useNavigate();
  return (e: SettingEntry) => navigate(e.path, { state: { highlight: e.target ?? null } });
}

/** "Search settings": while there is a query the results replace whatever `children` shows. */
export function SettingsSearch({ children }: { children: ReactNode }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const open = useOpenSetting();
  const results = searchSettings(query);
  return (
    <>
      <search className="settings-search">
        <label htmlFor={`${id}-q`} className="sr-only">
          Search settings
        </label>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          id={`${id}-q`}
          type="search"
          className="settings-search__input"
          placeholder="Search settings"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Enter" && results[0]) open(results[0]);
          }}
        />
      </search>
      {query.trim() ? (
        results.length ? (
          <List card aria-label="Search results">
            {results.map((r) => (
              <ListRow
                key={`${r.label}-${r.path}`}
                label={r.label}
                sublabel={groupTitle(r.group)}
                href={r.path}
                onClick={(ev) => {
                  ev.preventDefault();
                  open(r);
                }}
              />
            ))}
          </List>
        ) : (
          <p className="auth__hint" role="status">
            Nothing matches “{query.trim()}”. Try “passkey”, “export” or “dark mode”.
          </p>
        )
      ) : (
        children
      )}
    </>
  );
}

/** The groups as rows with a one-line blurb (the hub). */
export function GroupRows({ skip }: { skip?: string }) {
  const navigate = useNavigate();
  return (
    <List card aria-label="Settings groups">
      {GROUPS.filter((g) => g.key !== skip).map((g) => (
        <ListRow
          key={g.key}
          label={g.title}
          sublabel={g.blurb}
          href={g.path}
          onClick={(e) => {
            e.preventDefault();
            navigate(g.path);
          }}
        />
      ))}
    </List>
  );
}

/** 900px and up, beside a group's screen: search plus every group, the open one marked. */
export function SettingsSideNav() {
  return (
    <nav className="settings-nav" aria-label="Settings">
      <SettingsSearch>
        <ul className="settings-nav__list">
          <li>
            <NavLink to="/me" end className={navClass}>
              Me
            </NavLink>
          </li>
          {GROUPS.map((g) => (
            <li key={g.key}>
              <NavLink to={g.path} className={navClass}>
                {g.title}
              </NavLink>
            </li>
          ))}
        </ul>
      </SettingsSearch>
    </nav>
  );
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  cx("settings-nav__link", isActive && "settings-nav__link--active");
