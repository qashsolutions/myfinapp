/**
 * Names and links shared by every page: the product name, the company and the domain
 * (owner decisions, October 12, 2026). Set them here and nowhere else.
 */

export const NAME = "Qash";
export const COMPANY = "Qash Solutions Inc.";
export const DOMAIN = "qash.solutions";
export const APP_URL = import.meta.env.PUBLIC_APP_URL ?? `https://app.${DOMAIN}`;
/**
 * Whether the site links to the app. Off until the owner opens the app to the public (owner
 * decision, October 13, 2026): the app is deployed and reachable by its address for testing,
 * but no page sends visitors there. Build with PUBLIC_APP_LIVE=true to show every link.
 */
export const APP_LIVE = import.meta.env.PUBLIC_APP_LIVE === "true";
export const API_URL = import.meta.env.PUBLIC_API_URL ?? APP_URL;
/**
 * The app's install page (owner decision, October 19, 2026): shown on the website now, before
 * the rest of the app links open. On a phone it installs in a tap (Android) or walks through
 * Share → Add to Home Screen with pictures (iPhone).
 */
export const INSTALL_URL = `${APP_URL}/install`;
export const SUPPORT_EMAIL = `support@${DOMAIN}`;
export const SECURITY_EMAIL = `security@${DOMAIN}`;
export const LEGAL_UPDATED = "October 15, 2026";
export const DELETION_DAYS = "30"; // STACKD_DELETION_GRACE_DAYS in the API

/** The header: the product, nothing else (owner, October 15, 2026). */
export const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
];

/**
 * One footer for the website and the app's signed-out pages (owner, October 13, 2026: "the
 * footer needs to be consistent across all pages and sites"). The app keeps the same two rows
 * in apps/web/src/features/auth/AuthLayout.tsx (FOOTER_PRODUCT / FOOTER_LEGAL); change both.
 */
export const FOOTER_PRODUCT = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
];
/** Security and Support live here, not in the header; account deletion lives in the app
 * (Me → Delete account), and its public page is linked from the privacy policy and Support. */
export const FOOTER_LEGAL = [
  { href: "/security", label: "Security" },
  { href: "/support", label: "Support" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
];
export const FOOTER = [...FOOTER_PRODUCT, ...FOOTER_LEGAL];
