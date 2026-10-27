/** The product name people see (owner decision, October 12, 2026). */
export const APP_NAME = "Qash";

/** The public website (chunk 1W). Terms and privacy open there as web pages. */
export const SITE_URL =
  (import.meta.env.VITE_SITE_URL as string | undefined) ?? "https://qash.solutions";
export const TERMS_URL = `${SITE_URL}/terms`;
export const PRIVACY_URL = `${SITE_URL}/privacy`;

/** The company, as on the website's footer (apps/site/src/data/site.ts COMPANY). */
export const COMPANY = "Qash Solutions Inc.";
