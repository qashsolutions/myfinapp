import "./auth.css";

import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Logo } from "../../app/layout/Logo.tsx";
import { APP_NAME, COMPANY, SITE_URL } from "../../lib/brand.ts";
import { isNativePlatform, isStandalone } from "../../lib/platform.ts";
import { UpdateToast } from "../pwa/UpdateToast.tsx";

/** The website's footer, row for row (apps/site/src/data/site.ts FOOTER_PRODUCT / FOOTER_LEGAL;
 * owner, October 13, 2026: one footer across the site and the app). Change both together. */
const FOOTER_PRODUCT = [
  ["How it works", "/how-it-works"],
  ["Pricing", "/pricing"],
] as const;
const FOOTER_LEGAL = [
  ["Security", "/security"],
  ["Support", "/support"],
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
] as const;

/** In a browser tab the wordmark leads to the website; inside the installed or native app it
 * stays put, so nobody is sent out of the app by tapping the logo. */
function inBrowserTab(): boolean {
  return !isStandalone() && !isNativePlatform();
}

/** The frame for the sign-in flow: a back button or the wordmark, then the screen, and on the
 * signed-out start pages a slim footer with the website's links. */
export function AuthLayout({
  back,
  brand = false,
  footer = false,
  children,
}: {
  back?: string;
  brand?: boolean;
  footer?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const mark = (
    <>
      <Logo />
      <span>{APP_NAME}</span>
    </>
  );
  return (
    <div className="auth">
      <div className="auth__top">
        {back ? (
          <button
            type="button"
            className="auth__back"
            aria-label="Back"
            onClick={() => navigate(back)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M15 6l-6 6 6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        {brand ? (
          inBrowserTab() ? (
            <a className="auth__brand" href={SITE_URL} aria-label={`${APP_NAME} website`}>
              {mark}
            </a>
          ) : (
            <span className="auth__brand">{mark}</span>
          )
        ) : null}
      </div>
      {children}
      {footer ? (
        <footer className="auth__footer">
          <span className="auth__footer-brand">
            <Logo size={24} />
            <span>{APP_NAME}</span>
          </span>
          <nav aria-label={`About ${APP_NAME}`}>
            {[FOOTER_PRODUCT, FOOTER_LEGAL].map((row, i) => (
              <ul
                key={i === 0 ? "product" : "legal"}
                className={i ? "auth__footer-legal" : undefined}
              >
                {row.map(([label, path]) => (
                  <li key={path}>
                    <a href={`${SITE_URL}${path}`} target="_blank" rel="noopener">
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            ))}
          </nav>
          <p>© 2026 {COMPANY}</p>
        </footer>
      ) : null}
      {/* The sign-in pages are outside the app shell: offer a waiting update here too. */}
      <UpdateToast />
    </div>
  );
}
