import "./LookPicker.css";

import type { Look } from "@stackd/tokens";
import { loadLookFonts } from "../../app/lookFonts.ts";
import { LOOK_NAMES, useTheme } from "../../app/ThemeProvider.tsx";

/**
 * Settings → App look: one tile per look the platform offers, each drawn in that look's own
 * colours, borders, corners and type, so the choice is seen rather than read. A radio group;
 * picking applies at once, and `onPick` saves it to the account.
 */
export function LookPicker({ onPick }: { onPick: (look: Look) => void }) {
  const theme = useTheme();
  return (
    <fieldset className="look-picker">
      <legend className="sr-only">App look</legend>
      {theme.availableLooks.map((look) => (
        <label
          key={look}
          className="look-tile"
          data-look={look}
          data-mode={theme.resolvedMode}
          onPointerEnter={() => void loadLookFonts(look)}
        >
          <input
            type="radio"
            name="look"
            value={look}
            checked={theme.look === look}
            onFocus={() => void loadLookFonts(look)}
            onChange={() => onPick(look)}
          />
          <span className="look-tile__card" aria-hidden="true">
            <span className="look-tile__hero">$412</span>
            <span className="look-tile__line" />
            <span className="look-tile__chips">
              <span style={{ background: "var(--c-a2)" }} />
              <span style={{ background: "var(--c-a3)" }} />
              <span style={{ background: "var(--c-line)" }} />
            </span>
          </span>
          <span className="look-tile__name">{LOOK_NAMES[look]}</span>
        </label>
      ))}
    </fieldset>
  );
}
