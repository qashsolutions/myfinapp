import "./pwa.css";

import { Button, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { APP_NAME } from "../../lib/brand.ts";
import {
  canPromptInstall,
  dismissInstall,
  installPlatform,
  onInstallChange,
  promptInstall,
} from "../../pwa/install.ts";
import { IphoneSteps } from "./InstallSteps.tsx";

/**
 * Install guide (mockups PwaInstall, PwaInstallAndroid). iPhone: the Share → Add to Home Screen
 * steps, since Safari has no install event. Elsewhere: the benefits and the browser's own
 * install dialog when it offered one; otherwise the browser-menu hint.
 */
export function InstallGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  const platform = installPlatform();
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => onInstallChange(() => setCanPrompt(canPromptInstall())), []);

  function notNow() {
    dismissInstall();
    onClose();
  }

  async function install() {
    const outcome = await promptInstall();
    if (outcome === "accepted") {
      onClose();
      return;
    }
    if (outcome === "dismissed") {
      dismissInstall();
      onClose();
      return;
    }
    setNote("Use your browser's menu and choose Install app or Add to Home screen.");
  }

  return (
    <Sheet open={open} onClose={notNow} title={`Install ${APP_NAME}`}>
      {platform === "iphone" ? (
        <>
          <p className="auth__hint">Full screen, faster start, and reminders.</p>
          <IphoneSteps />
          <p className="auth__hint">
            Can't see Share? Scroll up a little to show Safari's toolbar.
          </p>
          <div className="install-actions">
            <Button variant="secondary" onClick={notNow}>
              Not now
            </Button>
            <Button onClick={onClose}>Got it</Button>
          </div>
        </>
      ) : (
        <>
          <p className="auth__hint">Works offline · No app store needed</p>
          <ul className="install-benefits">
            <li>Opens full screen from your home screen</li>
            <li>Log spending even with no signal</li>
            <li>Challenge reminders and bill alerts</li>
          </ul>
          <div className="install-actions">
            <Button variant="secondary" onClick={notNow}>
              Not now
            </Button>
            <Button onClick={install}>Install</Button>
          </div>
          <p className="auth__hint">
            {canPrompt
              ? "Tapping Install opens your browser's install dialog."
              : "If nothing opens, use your browser's menu: Install app or Add to Home screen."}
          </p>
          {note ? (
            <p className="auth__hint" role="status">
              {note}
            </p>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
