import "./pwa.css";

import type { ReactNode } from "react";
import { APP_NAME } from "../../lib/brand.ts";

/**
 * The install steps as pictures (October 19, 2026): each step is a small drawing of what the
 * person will see, the button to tap glowing, and three to five words. Drawings only, no
 * screenshots, so they read the same in every look.
 */

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <li className="istep">
      <div className="istep__pic" aria-hidden="true">
        {children}
      </div>
      <div className="istep__text">
        <span className="istep__n" aria-hidden="true">
          {n}
        </span>
        <span>
          <strong className="istep__title">{title}</strong>
          {hint ? <span className="istep__hint">{hint}</span> : null}
        </span>
      </div>
    </li>
  );
}

/** Safari's Share icon: a square with an arrow out of the top. */
export function ShareIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3v12M7.5 7.5L12 3l4.5 4.5M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusSquare() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function AppTile() {
  return (
    <span className="mock-tile">
      <img src="/icons/apple-touch-icon-180.png" alt="" width={44} height={44} />
      <span>{APP_NAME}</span>
    </span>
  );
}

/** iPhone, Safari: Share → Add to Home Screen → Add. */
export function IphoneSteps() {
  return (
    <ol className="isteps" aria-label="Steps">
      <Step n={1} title="Tap Share" hint="Newer iPhones: tap ••• first">
        <span className="mock-bar">
          <span className="mock-bar__btn">‹</span>
          <span className="mock-bar__btn">›</span>
          <span className="mock-bar__btn mock-glow">
            <ShareIcon />
          </span>
          <span className="mock-bar__btn">•••</span>
        </span>
      </Step>
      <Step n={2} title="Tap Add to Home Screen" hint="Scroll down if you don't see it">
        <span className="mock-menu">
          <span className="mock-menu__row">Copy</span>
          <span className="mock-menu__row mock-glow">
            Add to Home Screen <PlusSquare />
          </span>
        </span>
      </Step>
      <Step n={3} title="Tap Add">
        <span className="mock-top">
          <span>Cancel</span>
          <span className="mock-top__title">Add to Home Screen</span>
          <span className="mock-top__add mock-glow">Add</span>
        </span>
      </Step>
      <Step n={4} title={`Open ${APP_NAME} from your Home Screen`}>
        <AppTile />
      </Step>
    </ol>
  );
}

/** Android without the browser's own dialog: ⋮ → Install app. */
export function MenuSteps() {
  return (
    <ol className="isteps" aria-label="Steps">
      <Step n={1} title="Tap ⋮ at the top" hint="On this page, not a new tab">
        <span className="mock-top">
          <span className="mock-url">app.qash.solutions</span>
          <span className="mock-top__add mock-glow">⋮</span>
        </span>
      </Step>
      <Step n={2} title="Tap Install app" hint="Or: Add to Home screen">
        <span className="mock-menu">
          <span className="mock-menu__row mock-menu__row--blank" />
          <span className="mock-menu__row mock-glow">Install app</span>
        </span>
      </Step>
      <Step n={3} title={`Open ${APP_NAME} from your Home Screen`}>
        <AppTile />
      </Step>
    </ol>
  );
}

/** Chrome's install icon at the right end of the address bar: a screen with a down arrow. */
export function InstallIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10 4H5a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 5 17h14a1.5 1.5 0 0 0 1.5-1.5V12M9 21h6M12 17v4M17 3v7M14 7l3 3 3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AddressBar({ glow }: { glow: ReactNode }) {
  return (
    <span className="mock-top">
      <span className="mock-url">app.qash.solutions</span>
      <span className="mock-top__add mock-glow">{glow}</span>
    </span>
  );
}

function InstallDialog() {
  return (
    <span className="mock-menu">
      <span className="mock-menu__row">
        <span className="mock-top__title">Install app?</span>
      </span>
      <span className="mock-menu__row mock-menu__row--end">
        <span>Cancel</span>
        <span className="mock-top__add mock-glow">Install</span>
      </span>
    </span>
  );
}

/**
 * A computer (November 17, 2026): each browser's own way in. Chrome and the browsers built on it
 * show an install icon in the address bar, and only while Qash's page is open, never in a new
 * tab; Edge keeps it under ••• → Apps; Safari on a Mac under File → Add to Dock. Firefox gets
 * no steps here: it can't install apps on a computer, and the screen says so.
 */
export function DesktopSteps({ browser }: { browser: "chrome" | "edge" | "safari" | "other" }) {
  if (browser === "safari")
    return (
      <ol className="isteps" aria-label="Steps">
        <Step n={1} title="Click File in the menu bar" hint="At the top of your screen">
          <span className="mock-bar">
            <span className="mock-bar__word">Safari</span>
            <span className="mock-bar__word mock-glow">File</span>
            <span className="mock-bar__word">Edit</span>
            <span className="mock-bar__word">View</span>
          </span>
        </Step>
        <Step n={2} title="Click Add to Dock" hint="Needs macOS Sonoma or later">
          <span className="mock-menu">
            <span className="mock-menu__row mock-menu__row--blank" />
            <span className="mock-menu__row mock-glow">Add to Dock…</span>
          </span>
        </Step>
        <Step n={3} title="Click Add">
          <span className="mock-top">
            <span>Cancel</span>
            <span className="mock-top__title">Add to Dock</span>
            <span className="mock-top__add mock-glow">Add</span>
          </span>
        </Step>
        <Step n={4} title={`Open ${APP_NAME} from the Dock`}>
          <AppTile />
        </Step>
      </ol>
    );
  if (browser === "edge")
    return (
      <ol className="isteps" aria-label="Steps">
        <Step n={1} title="Click ••• at the top right" hint="On this page, not a new tab">
          <AddressBar glow="•••" />
        </Step>
        <Step
          n={2}
          title={`Click Apps, then Install ${APP_NAME}`}
          hint="Or: Install this site as an app"
        >
          <span className="mock-menu">
            <span className="mock-menu__row mock-menu__row--blank" />
            <span className="mock-menu__row mock-glow">Apps ›</span>
          </span>
        </Step>
        <Step n={3} title="Click Install">
          <InstallDialog />
        </Step>
        <Step n={4} title={`Open ${APP_NAME} like any app`}>
          <AppTile />
        </Step>
      </ol>
    );
  return (
    <>
      <ol className="isteps" aria-label="Steps">
        <Step
          n={1}
          title="Click the install icon"
          hint="On this page, at the right end of the address bar. Not in a new tab."
        >
          <AddressBar glow={<InstallIcon />} />
        </Step>
        <Step n={2} title="Click Install">
          <InstallDialog />
        </Step>
        <Step n={3} title={`Open ${APP_NAME} like any app`}>
          <AppTile />
        </Step>
      </ol>
      <p className="istep__hint install-or">
        No icon? Open the menu ⋮ → Cast, save, and share → Install {APP_NAME}.
        {browser === "other" ? " Or open this page in Chrome, Edge or Safari." : ""}
      </p>
    </>
  );
}
