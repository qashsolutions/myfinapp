import "../auth/auth.css";

import { Card } from "@stackd/ui";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { LOOKS, useTheme } from "../../app/ThemeProvider.tsx";
import { api } from "../../data/api.ts";
import { DisplaySettings } from "./DisplaySettings.tsx";
import { LookPicker } from "./LookPicker.tsx";

/** Me → Look & feel: the app look, dark mode, Simple layout, sounds and celebrations. */
export function LookSettings() {
  const theme = useTheme();
  return (
    <>
      <ScreenHeader title="Look & feel" actions={null} back="/me" />
      <Card as="section" aria-labelledby="looks-h" id="set-look">
        <h2 className="sk-card__title" id="looks-h">
          App look
        </h2>
        <LookPicker
          onPick={(look) => {
            // Instant on this device; the account keeps it for every other device.
            theme.setLook(look);
            void api.PATCH("/api/account", { body: { look } });
          }}
        />
        <p className="auth__hint">
          Same screens and wording in every look; only colours, type and shapes change.
          {theme.availableLooks.length < LOOKS.length
            ? " Minimal, Retro 80s and Illustrative are in the web app too."
            : ""}
        </p>
      </Card>
      <div id="set-display">
        <DisplaySettings />
      </div>
    </>
  );
}
