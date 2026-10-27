import "../../moments/moments.css";

import { List, Toggle } from "@stackd/ui";
import { useTheme } from "../../app/ThemeProvider.tsx";
import { setMomentPref, useMomentPref } from "../../moments/prefs.ts";
import { playSound } from "../../moments/sound.ts";

/**
 * Settings → Display: Dark mode, Match system, Simple layout (docs/spec.md "Settings spec").
 * Match system overrides Dark mode while it is on. Changes apply instantly and persist.
 */
export function DisplaySettings() {
  const { mode, resolvedMode, simpleLayout, setMode, setSimpleLayout } = useTheme();
  const matchSystem = mode === "system";
  const sounds = useMomentPref("sounds");
  const celebrations = useMomentPref("celebrations");
  return (
    <section aria-labelledby="display-h">
      <h2 className="section-title" id="display-h">
        Display
      </h2>
      <List card>
        <li className="sk-list__item">
          <Toggle
            label="Dark mode"
            description={matchSystem ? "Following your device while Match system is on" : undefined}
            checked={resolvedMode === "dark"}
            disabled={matchSystem}
            onChange={(on) => setMode(on ? "dark" : "light")}
          />
        </li>
        <li className="sk-list__item">
          <Toggle
            label="Match system"
            checked={matchSystem}
            onChange={(on) => setMode(on ? "system" : resolvedMode)}
          />
        </li>
        <li className="sk-list__item">
          <Toggle
            label="Simple layout"
            description="Plain lists instead of tiles, and no decorations"
            checked={simpleLayout}
            onChange={setSimpleLayout}
          />
        </li>
        <li className="sk-list__item sound-row">
          <Toggle
            label="Sounds"
            description="A ka-ching when money goes into a jar or comes in"
            checked={sounds}
            onChange={(on) => setMomentPref("sounds", on)}
          />
          {sounds ? (
            <button
              type="button"
              className="sound-preview"
              aria-label="Play the ka-ching"
              onClick={() => playSound("kaching")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3a6 6 0 0 0-6 6v3.5L4.5 15v1.5h15V15L18 12.5V9a6 6 0 0 0-6-6Zm-2.2 15.5a2.3 2.3 0 0 0 4.4 0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </li>
        <li className="sk-list__item">
          <Toggle
            label="Celebrations"
            description="Confetti for deposits and goals. Off when your device asks for less motion"
            checked={celebrations}
            onChange={(on) => setMomentPref("celebrations", on)}
          />
        </li>
      </List>
    </section>
  );
}
