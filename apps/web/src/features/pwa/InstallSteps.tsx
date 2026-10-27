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

/** Android or a computer without the browser's own dialog: the menu → Install app. */
export function MenuSteps({ desktop = false }: { desktop?: boolean }) {
  return (
    <ol className="isteps" aria-label="Steps">
      <Step n={1} title={desktop ? "Open the browser menu" : "Tap ⋮ at the top"}>
        <span className="mock-top">
          <span className="mock-url">app.qash.solutions</span>
          <span className="mock-top__add mock-glow">⋮</span>
        </span>
      </Step>
      <Step n={2} title="Tap Install app" hint="Or: Add to Home screen">
        <span className="mock-menu">
          <span className="mock-menu__row">New tab</span>
          <span className="mock-menu__row mock-glow">Install app</span>
        </span>
      </Step>
      <Step
        n={3}
        title={desktop ? `Open ${APP_NAME} like any app` : `Open ${APP_NAME} from your Home Screen`}
      >
        <AppTile />
      </Step>
    </ol>
  );
}
