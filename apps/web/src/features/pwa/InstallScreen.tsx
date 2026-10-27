import "./pwa.css";

import { Button, buttonClass, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { APP_NAME } from "../../lib/brand.ts";
import { isStandalone } from "../../lib/platform.ts";
import {
  canPromptInstall,
  installTarget,
  onInstallChange,
  promptInstall,
} from "../../pwa/install.ts";
import { AuthLayout } from "../auth/AuthLayout.tsx";
import { IphoneSteps, MenuSteps, ShareIcon } from "./InstallSteps.tsx";

const INSTALL_URL = "https://app.qash.solutions/install";

/**
 * /install (October 19, 2026): where the website's "Install the app" button lands. Android and
 * computers get the browser's own one-tap install when it's offered; iPhone gets the picture
 * steps with an arrow at Safari's Share button; other iPhone browsers are asked to open Safari.
 * Public: no sign-in needed, and nothing here talks to the server.
 */
export function InstallScreen() {
  const target = installTarget();
  const [installed, setInstalled] = useState(isStandalone());
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => onInstallChange(() => setCanPrompt(canPromptInstall())), []);

  async function install() {
    const outcome = await promptInstall();
    if (outcome === "accepted") setInstalled(true);
    else if (outcome === "unavailable") setNote("Use the steps below instead.");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(INSTALL_URL);
      setNote("Link copied. Paste it into Safari.");
    } catch {
      setNote(`Open Safari and go to ${INSTALL_URL.replace("https://", "")}`);
    }
  }

  if (installed) {
    return (
      <AuthLayout brand>
        <h1 className="auth__title">You're all set</h1>
        <p className="auth__lede">{APP_NAME} is on your Home Screen.</p>
        <Link to="/" className={buttonClass({ block: true })}>
          Open {APP_NAME}
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout brand>
      <h1 className="auth__title">Install {APP_NAME}</h1>
      <p className="auth__lede">One tap from your Home Screen. Free.</p>
      {target === "iphone_other" ? (
        <Card as="section" aria-label="Open in Safari">
          <p className="istep__title">Open this page in Safari</p>
          <p className="istep__hint">iPhone installs apps from Safari only</p>
          <Button block onClick={copyLink}>
            Copy link
          </Button>
        </Card>
      ) : null}
      {target === "iphone_safari" ? (
        <>
          <IphoneSteps />
          <div className="install-pointer" aria-hidden="true">
            <span className="install-pointer__label">
              <ShareIcon size={18} /> Share is down here
            </span>
            <span className="install-pointer__arrow">↓</span>
          </div>
        </>
      ) : null}
      {target === "android" || target === "desktop" ? (
        <>
          {canPrompt ? (
            <Button block onClick={install}>
              {target === "desktop" ? "Install on this computer" : `Install ${APP_NAME}`}
            </Button>
          ) : null}
          {canPrompt ? (
            <p className="istep__hint install-or">Nothing happened? Use these steps:</p>
          ) : null}
          <MenuSteps desktop={target === "desktop"} />
          {target === "desktop" ? (
            <p className="istep__hint">On your phone, open {INSTALL_URL.replace("https://", "")}</p>
          ) : null}
        </>
      ) : null}
      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}
    </AuthLayout>
  );
}
