import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the payments e2e: Stripe's test-mode API (the key is read from services/api/.env
 * and never printed; anything but a test key is refused), the e2e database, and the app's
 * own billing endpoints as the signed-in page sees them.
 */
const API_DIR = join(import.meta.dirname, "..", "..", "..", "services", "api");
const ENV = readFileSync(join(API_DIR, ".env"), "utf8");
const setting = (name: string) => ENV.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
const KEY = setting("STACKD_STRIPE_SECRET_KEY");
if (!/^(sk|rk)_test_/.test(KEY)) throw new Error("refusing: not a Stripe test key");

type Json = Record<string, unknown> & { data?: Json[]; id?: string };

export async function stripe(
  method: "GET" | "POST" | "DELETE",
  path: string,
  form: Record<string, string> = {},
): Promise<Json> {
  const body = new URLSearchParams(form).toString();
  const url = `https://api.stripe.com/v1${path}${method === "GET" && body ? `?${body}` : ""}`;
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : body,
  });
  const json = (await r.json()) as Json;
  if (!r.ok) throw new Error(`Stripe ${method} ${path}: ${JSON.stringify(json.error)}`);
  return json;
}

/** Run SQL against the e2e database (stackd_e2e), returning rows as tab-separated text. */
export function sql(query: string): string {
  const base = setting("STACKD_DATABASE_URL").replace("postgresql+psycopg://", "postgresql://");
  const url = `${base.slice(0, base.lastIndexOf("/"))}/stackd_e2e`;
  return execFileSync("psql", [url, "-At", "-F", "\t", "-c", query], { encoding: "utf8" }).trim();
}

export const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Move this account's trial end: into the past so a checkout charges at once; with under
 * 49 hours left the first charge still waits for the trial end (billing_cycle_anchor). */
export function setTrialEnd(email: string, interval: string): void {
  sql(
    `UPDATE users SET trial_ends_at = now() + interval ${quote(interval)} WHERE email = ${quote(email)}`,
  );
}

export interface Billing {
  plan: string;
  status: string | null;
  interval: string | null;
  ends_at: string | null;
  payment_pending?: boolean;
  foreign_card_refused?: boolean;
  founding: { left: number };
  entitlements: { access?: { state?: string } };
}

export async function billing(page: Page): Promise<Billing> {
  const r = await page.request.get("/api/billing");
  expect(r.ok()).toBe(true);
  return (await r.json()) as Billing;
}

/** Wait until the server's view of this account matches (webhooks arrive a little later). */
export async function waitForPlan(
  page: Page,
  check: (b: Billing) => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<Billing> {
  const until = Date.now() + timeoutMs;
  let last: Billing | null = null;
  while (Date.now() < until) {
    last = await billing(page);
    if (check(last)) return last;
    await page.waitForTimeout(1500);
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

/** Emails the console backend printed to this address, by subject. */
export function subjectsTo(email: string): string[] {
  const log = readFileSync(join(import.meta.dirname, "..", "e2e", ".output", "api.log"), "utf8");
  const re = new RegExp(`--- email to ${email.replace(/[.+]/g, "\\$&")}\\nSubject: (.*)`, "g");
  return [...log.matchAll(re)].map((m) => m[1] as string);
}

/** The Stripe customer Qash stored for this account, once a checkout has completed. */
export function customerOf(email: string): string {
  return sql(
    `SELECT s.customer_id FROM subscriptions s JOIN users u ON u.id = s.user_id
     WHERE u.email = ${quote(email)} AND s.customer_id IS NOT NULL
     ORDER BY s.created_at DESC LIMIT 1`,
  );
}

export function userIdOf(email: string): string {
  return sql(`SELECT id FROM users WHERE email = ${quote(email)}`);
}

/** Test clocks: create one, and advance it until Stripe says it's ready. */
export async function newClock(at = Math.floor(Date.now() / 1000)): Promise<string> {
  return (await stripe("POST", "/test_helpers/test_clocks", { frozen_time: String(at) }))
    .id as string;
}

export async function advanceClock(clock: string, to: number): Promise<void> {
  await stripe("POST", `/test_helpers/test_clocks/${clock}/advance`, { frozen_time: String(to) });
  for (let i = 0; i < 120; i++) {
    const c = await stripe("GET", `/test_helpers/test_clocks/${clock}`);
    if (c.status === "ready") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("test clock never became ready");
}

export async function deleteClock(clock: string): Promise<void> {
  await stripe("DELETE", `/test_helpers/test_clocks/${clock}`).catch(() => undefined);
}

export const DAY = 86_400;

/** The test-mode price ids the API uses (services/api/.env). */
export const PRICES = {
  private_monthly: setting("STACKD_STRIPE_PRICE_PRIVATE_MONTHLY"),
  private_yearly: setting("STACKD_STRIPE_PRICE_PRIVATE_YEARLY"),
  connected_monthly: setting("STACKD_STRIPE_PRICE_CONNECTED_MONTHLY"),
  connected_yearly: setting("STACKD_STRIPE_PRICE_CONNECTED_YEARLY"),
};

/**
 * A subscription made the way Checkout makes one (same metadata, so the same webhooks reach
 * the same code), on a customer tied to a test clock so months pass in seconds.
 */
export async function clockSubscription(
  email: string,
  plan: "private" | "connected",
  interval: "monthly" | "yearly",
  options: { clock: string; card?: string; trialEnd?: number },
): Promise<{ customer: string; subscription: string }> {
  const userId = userIdOf(email);
  const customer = await stripe("POST", "/customers", { email, test_clock: options.clock });
  const pm = await stripe("POST", `/payment_methods/${options.card ?? "pm_card_visa"}/attach`, {
    customer: customer.id as string,
  });
  await stripe("POST", `/customers/${customer.id}`, {
    "invoice_settings[default_payment_method]": pm.id as string,
  });
  const form: Record<string, string> = {
    customer: customer.id as string,
    "items[0][price]": PRICES[`${plan}_${interval}`],
    "metadata[user_id]": userId,
    "metadata[plan]": plan,
    "metadata[interval]": interval,
  };
  if (options.trialEnd) form.trial_end = String(options.trialEnd);
  const sub = await stripe("POST", "/subscriptions", form);
  return { customer: customer.id as string, subscription: sub.id as string };
}

/** Make the customer's next charges fail (Stripe's "attaches, then every charge fails" card). */
export async function failNextCharges(customer: string): Promise<void> {
  const pm = await stripe("POST", "/payment_methods/pm_card_chargeCustomerFail/attach", {
    customer,
  });
  await stripe("POST", `/customers/${customer}`, {
    "invoice_settings[default_payment_method]": pm.id as string,
  });
  // A subscription can carry its own payment method, which wins over the customer's: set it
  // there too, so the next renewal really uses the failing card.
  const subs = await stripe("GET", "/subscriptions", { customer, status: "all" });
  for (const sub of subs.data ?? []) {
    await stripe("POST", `/subscriptions/${sub.id}`, {
      default_payment_method: pm.id as string,
    });
  }
}

export async function clockNow(clock: string): Promise<number> {
  return (await stripe("GET", `/test_helpers/test_clocks/${clock}`)).frozen_time as number;
}

/**
 * What a lost dispute or a fraud-warning refund put on Stripe's test-mode block lists for this
 * account (its cards' fingerprints, and its email, which Stripe adds on a "fraudulent" refund),
 * so a rerun can pay with the same test card. Only these items are removed, never others.
 */
export async function blockedFor(email: string): Promise<Array<{ id: string; value: string }>> {
  const charges = await stripe("GET", "/charges", { customer: customerOf(email) });
  const mine = new Set<string>([email]);
  for (const c of charges.data ?? []) {
    const fp = (c.payment_method_details as { card?: { fingerprint?: string } })?.card?.fingerprint;
    if (fp) mine.add(fp);
  }
  const found: Array<{ id: string; value: string }> = [];
  for (const alias of ["card_fingerprint_blocklist", "email_blocklist"]) {
    const list = (await stripe("GET", "/radar/value_lists", { alias })).data?.[0];
    if (!list) continue;
    const items = await stripe("GET", "/radar/value_list_items", {
      value_list: list.id as string,
      limit: "100",
    });
    for (const item of items.data ?? [])
      if (mine.has(String(item.value)))
        found.push({ id: item.id as string, value: String(item.value) });
  }
  return found;
}

export async function unblock(email: string): Promise<void> {
  for (const item of await blockedFor(email))
    await stripe("DELETE", `/radar/value_list_items/${item.id}`);
}
