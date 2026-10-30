import "./billing.css";
import "../auth/auth.css";
import "../entries/entries.css";

import { Button, Card, Chip, List, ListRow, ProgressBar, Sheet } from "@stackd/ui";
import { useCallback, useEffect, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { failureText } from "../../data/api.ts";
import { formatCents, formatDate, formatWholeDollars } from "../../lib/format.ts";
import {
  buyPlanNative,
  nativeBillingAvailable,
  openStoreSubscriptions,
  restorePurchasesNative,
} from "../../native/purchases.ts";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "../security/StepUpPrompt.tsx";
import {
  type BillingOut,
  type ChangePreview,
  type CheckoutPlan,
  type ConsentText,
  type Credit,
  changePlan,
  changeRenewal,
  fetchCancelConsent,
  fetchCredit,
  fetchPurchaseConsent,
  type Interval,
  isFailure,
  openPortal,
  previewChange,
  priceCents,
  setTesterPlan,
  startCheckout,
  useBilling,
} from "./billing.ts";
import { type Access, parseEntitlements, planLine, useEntitlements } from "./entitlements.ts";
import { PlanHistory } from "./PlanHistory.tsx";
import { endNotice } from "./planEnd.ts";

/** Whole-percent saving of yearly over twelve monthly payments, for the picker label only. */
function yearlySavingPercent(billing: BillingOut): number {
  let best = 0;
  for (const p of Object.values(billing.prices)) {
    const twelve = p.monthly_cents * 12;
    if (twelve <= 0) continue;
    const saved = Math.round(((twelve - p.yearly_cents) * 100) / twelve);
    if (saved > best) best = saved;
  }
  return best;
}

function currentLine(billing: BillingOut, access: Access | null): string {
  const { plan, interval, renews_at, ends_at, cancel_at_period_end, founding } = billing;
  // A household of two is one plan (owner decision, October 29, 2026; invariant 54).
  if (billing.shared === "covered" && access?.state === "subscribed")
    return `Shared with ${billing.shared_by ?? "your partner"} · one price covers you both`;
  if (billing.shared === "covered" && access?.state === "paused")
    return "Paused while a question about its payment is settled";
  if (access?.state === "trial" && access.trial_ends_at)
    return `Free trial · until ${formatDate(access.trial_ends_at)}, no card needed`;
  if (access?.state === "lapsed" && access.delete_at)
    return `Wrapped up · your account stays open until ${formatDate(access.delete_at)}`;
  if (access?.state === "paused") return "Paused while a payment is disputed";
  if (access?.state === "ended") return "Ended · your bank returned the payment";
  if (access?.state === "choose" && access.trial_used)
    return "Your free trial was already used on this email.";
  if (plan === "free") return "No plan yet";
  if (plan === "founding") {
    const once = formatCents(Number(founding.one_time_cents ?? 0));
    return `${once} once · Connected until ${ends_at ? formatDate(ends_at) : "the end of the term"} · doesn't renew`;
  }
  const per = interval === "yearly" ? "a year" : "a month";
  const price = formatCents(
    priceCents(billing, plan, interval === "yearly" ? "yearly" : "monthly"),
  );
  if (cancel_at_period_end && renews_at)
    return `${price} ${per} · ends ${formatDate(renews_at)}; renew to keep your data`;
  if (billing.status === "past_due") return `${price} ${per} · payment failed, update your card`;
  return `${price} ${per}${renews_at ? ` · renews ${formatDate(renews_at)}` : ""}`;
}

/**
 * Your plan (mockups F6Plan and F2Plan; docs/spec.md "Plans & billing" and "Founding member
 * offer"): the current plan with its renewal line, Stripe's Customer Portal for receipts and
 * the card, switching plans here (October 17, 2026: an upgrade starts at once and is charged
 * the difference; a downgrade waits for the end of the paid period, shown as "Switches to …"),
 * Cancel plan / Keep my plan straight from here (renewal stops; the plan runs to
 * the end of the period already paid for; then 7 days to resubscribe or export before deletion), and the picker for Private / Connected plus the Founding
 * member offer through Stripe Checkout. Price, renewal terms and how to cancel are shown here
 * before anything is bought; a passkey check comes before either Stripe page.
 */
export function PlanScreen() {
  const ids = useId();
  const stepUp = useStepUp();
  const { billing, error, refresh } = useBilling();
  const { refresh: refreshEntitlements } = useEntitlements();
  const [params, setParams] = useSearchParams();
  const [interval, setInterval] = useState<Interval>("yearly");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The "If you cancel" lines, from the server; the sheet is open while they are here.
  const [cancelConsent, setCancelConsent] = useState<ConsentText | null>(null);
  // Ticked before cancelling (owner decision, October 18, 2026), kept like a purchase's.
  const [cancelAgreed, setCancelAgreed] = useState(false);
  const cancelAgreeId = useId();
  // A switch down that isn't open yet: the sheet says when and why (October 18, 2026).
  const [lockedFor, setLockedFor] = useState<string | null>(null);
  // "Before you subscribe" for one offer, with the server's lines for it.
  const [pending, setPending] = useState<{
    plan: CheckoutPlan;
    interval: Interval;
    consent: ConsentText;
  } | null>(null);
  const [change, setChange] = useState<{
    plan: "private" | "connected";
    interval: Interval;
    preview: ChangePreview;
  } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [credit, setCredit] = useState<Credit | null>(null);
  const agreeId = useId();
  const session = useSession();
  const native = nativeBillingAvailable(); // chunk 2.4: buy and manage through the store
  const subscribed =
    !native &&
    billing?.source === "stripe" &&
    (billing.plan === "private" || billing.plan === "connected") &&
    (billing.status === "active" || billing.status === "past_due") &&
    parseEntitlements(billing.entitlements)?.access?.state !== "trial";

  const loadCredit = useCallback(async () => {
    const r = await fetchCredit();
    setCredit(isFailure(r) ? null : r);
  }, []);
  const hasCustomer = billing?.has_customer === true;
  useEffect(() => {
    if (hasCustomer) void loadCredit();
  }, [hasCustomer, loadCredit]);

  const outcome = params.get("checkout");
  useEffect(() => {
    if (!outcome) return;
    setStatus(
      outcome === "success"
        ? "Thanks! Your plan updates as soon as the payment is confirmed, usually within a minute."
        : "No charge was made. Your plan is unchanged.",
    );
    void refreshEntitlements();
    void refresh();
    setParams({}, { replace: true });
  }, [outcome, refresh, refreshEntitlements, setParams]);

  // "Stop mine" on joining a household (owner decision, October 29, 2026): the join screen
  // brings the person here to stop their own plan with the usual "If you cancel" sheet, so
  // nothing stops without their tick and tap.
  const stopAsked = params.get("stop") === "1";
  // biome-ignore lint/correctness/useExhaustiveDependencies: openCancel only sets state and asks the server; this runs once per request
  useEffect(() => {
    if (!stopAsked || !billing) return;
    setParams({}, { replace: true });
    if (billing.cancel_at_period_end || !billing.own_plan) return;
    if (billing.source === "stripe") void openCancel();
    else
      setStatus(
        billing.source === "apple"
          ? "You bought your plan in the App Store: stop it there, in your subscriptions."
          : "You bought your plan in Google Play: stop it there, in your subscriptions.",
      );
  }, [stopAsked, billing, setParams]);

  /** Web purchases open "Before you subscribe" first (October 14, 2026): the renewal terms are
   * read and ticked before the payment page, as auto-renewal laws expect. The lines are the
   * server's (October 28, 2026), shown and sent back as they came. */
  async function choose(plan: CheckoutPlan, iv: Interval = interval) {
    if (native && plan !== "founding") return chooseNative(plan);
    if (!billing?.available) return;
    // A bank payment still clearing: never a second purchase beside it (October 28, 2026).
    if (billing.payment_pending) return;
    // Already paying: a switch on the same subscription, never a second one.
    if (plan !== "founding" && subscribed) return void openChange(plan, iv);
    setStatus(null);
    setBusy(true);
    const consent = await fetchPurchaseConsent(plan, iv);
    setBusy(false);
    if (isFailure(consent)) {
      setStatus(
        consent.status === 0
          ? "You're offline. Try again when connected."
          : "Couldn't load the terms. Try again.",
      );
      return;
    }
    setAgreed(false);
    setPending({ plan, interval: iv, consent });
  }

  async function openCancel() {
    setStatus(null);
    setBusy(true);
    const consent = await fetchCancelConsent();
    setBusy(false);
    if (isFailure(consent)) {
      setStatus(
        consent.status === 0
          ? "You're offline. Try again when connected."
          : "Couldn't load the terms. Try again.",
      );
      return;
    }
    setCancelAgreed(false);
    setCancelConsent(consent);
  }

  async function openChange(plan: "private" | "connected", iv: Interval) {
    setStatus(null);
    setBusy(true);
    const preview = await previewChange(plan, iv);
    setBusy(false);
    if (isFailure(preview)) {
      setStatus(
        preview.status === 0
          ? "You're offline. Try again when connected."
          : "Couldn't work out the change. Try again.",
      );
      return;
    }
    setAgreed(false);
    setChange({ plan, interval: iv, preview });
  }

  async function confirmChange() {
    if (!billing || !change) return;
    const { plan, interval: iv, preview } = change;
    setChange(null);
    if (!(await stepUp.confirm("Changing your plan"))) return;
    setBusy(true);
    const result = await changePlan(plan, iv, preview.proration_date, preview.consent);
    setBusy(false);
    if (isFailure(result)) {
      setStatus(
        result.code === "payment_failed"
          ? "Your card was declined, so nothing changed. Update it in Receipts & invoices and try again."
          : result.code === "downgrade_too_soon"
            ? "You changed plans less than 30 days ago. You can switch down after that."
            : result.code === "consent_mismatch" || result.code === "consent_outdated"
              ? "The amounts changed since you looked. Nothing was charged. Open the switch again to see them."
              : result.status === 0
                ? "You're offline. Try again when connected."
                : "Couldn't change your plan. Nothing was charged. Try again.",
      );
      return;
    }
    await refresh();
    void refreshEntitlements();
    void loadCredit();
    const credit =
      preview.kind === "down" && preview.credit_after_cents > 0
        ? ` ${formatCents(preview.credit_after_cents)} credit is on your account for your next bills.`
        : "";
    setStatus(`Done. You're on ${PLAN_NAMES[plan]} · ${iv} now.${credit}`);
  }

  /** Tester tools: the admin's own plan, free, behind a passkey check like any plan change. */
  async function testAs(plan: "free" | "private" | "connected" | "founding" | null) {
    setStatus(null);
    if (!(await stepUp.confirm("Switching your test plan"))) return;
    setBusy(true);
    const result = await setTesterPlan(plan);
    setBusy(false);
    if (isFailure(result)) {
      setStatus(failureText(result, "Couldn't switch the test plan. Try again."));
      return;
    }
    await refresh();
    await refreshEntitlements();
    setStatus(
      plan
        ? `Testing as ${TESTER_NAMES[plan]}. Nothing is charged.`
        : `Back to your real plan: ${result.label}.`,
    );
  }

  async function proceed(offer: { plan: CheckoutPlan; interval: Interval; consent: ConsentText }) {
    if (!billing) return;
    const { plan, interval: iv, consent } = offer;
    setPending(null);
    setStatus(null);
    if (!(await stepUp.confirm("Changing your plan"))) return;
    setBusy(true);
    const failure = await startCheckout(plan, plan === "founding" ? null : iv, consent);
    setBusy(false);
    if (!failure) return;
    setStatus(
      failure.code === "already_founding"
        ? "You're a Founding member: Connected is yours for the whole term."
        : failure.code === "cancel_first"
          ? "To become a Founding member, cancel your current plan first. It runs to the end of what you've paid, and you can buy Founding straight after."
          : failure.code === "already_subscribed"
            ? "You already have a plan. Choose another one above to switch."
            : failure.code === "payment_pending"
              ? "Your bank payment is still clearing. Once it does, you can change plans here."
              : failure.code === "manage_in_store"
                ? "Your plan was bought in the App Store or Google Play. Change or cancel it there first."
                : failure.code === "founding_sold_out"
                  ? "All the Founding places are taken. Connected is still here for you."
                  : failure.code === "purchase_blocked"
                    ? "We can't take a new payment on this account. Write to support@qash.solutions and we'll help."
                    : failure.code === "consent_outdated"
                      ? "The terms changed. Reload the app and review them again."
                      : failure.code === "consent_mismatch"
                        ? "The terms changed since you opened them. Choose the plan again to see them."
                        : failure.status === 0
                          ? "You're offline. Try again when connected."
                          : "Couldn't open the payment page. Try again.",
    );
  }

  /** The store's payment sheet; the server verifies the store's proof before the plan moves. */
  async function chooseNative(plan: "private" | "connected") {
    const productId = billing?.store_products?.[plan]?.[interval];
    const accountToken = session.info?.user?.id;
    if (!productId || !accountToken) return;
    setStatus(null);
    if (!(await stepUp.confirm("Changing your plan"))) return;
    setBusy(true);
    const outcome = await buyPlanNative(productId, accountToken);
    setBusy(false);
    if (outcome === "cancelled") return;
    if (outcome === "failed") {
      setStatus(
        "The store couldn't complete the purchase. Nothing was charged that we know of; check the store app.",
      );
      return;
    }
    setStatus("Thanks! Your plan is updated.");
    await refreshEntitlements();
    await refresh();
  }

  async function restore() {
    const accountToken = session.info?.user?.id;
    if (!accountToken) return;
    setStatus(null);
    setBusy(true);
    const synced = await restorePurchasesNative(accountToken);
    setBusy(false);
    setStatus(
      synced > 0 ? "Restored. Your plan is updated." : "Nothing to restore on this store account.",
    );
    if (synced > 0) {
      await refreshEntitlements();
      await refresh();
    }
  }

  async function portal(what: string) {
    // Receipts stay reachable after a plan ends, even while plans aren't on sale (the server
    // answers when Stripe isn't set up at all).
    if (!billing?.has_customer) return;
    setStatus(null);
    if (!(await stepUp.confirm(what))) return;
    setBusy(true);
    const failure = await openPortal();
    setBusy(false);
    if (!failure) return;
    setStatus(
      failure.status === 0
        ? "You're offline. Try again when connected."
        : "Couldn't open the billing page. Try again.",
    );
  }

  async function setRenewal(cancel: ConsentText | null) {
    if (!billing) return;
    setStatus(null);
    if (!(await stepUp.confirm(cancel ? "Cancelling your plan" : "Keeping your plan"))) return;
    setBusy(true);
    const result = await changeRenewal(cancel);
    setBusy(false);
    if (isFailure(result)) {
      setStatus(
        result.status === 0
          ? "You're offline. Try again when connected."
          : result.code === "consent_mismatch"
            ? "The terms changed since you opened them. Open Cancel plan again to see them."
            : "Couldn't change your plan. Try again.",
      );
      return;
    }
    const updated = result as BillingOut;
    await refresh();
    void refreshEntitlements();
    const until = updated.renews_at ? formatDate(updated.renews_at) : "the end of the period";
    setStatus(
      cancel
        ? `Cancelled. ${updated.label} stays on until ${until}. Renew before then to keep your data.`
        : `Kept. ${updated.label} renews on ${until} as usual.`,
    );
  }

  if (!billing) {
    return (
      <>
        <ScreenHeader title="Your plan" actions={null} back="/me/account" />
        {error ? (
          <Card>
            <p>Couldn't load your plan. Check your connection and try again.</p>
          </Card>
        ) : (
          <p className="sr-only" role="status">
            Loading
          </p>
        )}
      </>
    );
  }

  const limits = parseEntitlements(billing.entitlements);
  const onTrial = limits?.access?.state === "trial";
  // Covered by the partner's plan while paying for one of their own (owner decision, October
  // 29, 2026): the screen shows the household's plan and offers to stop their own.
  const covered = billing.shared === "covered" && limits?.access?.state === "subscribed";
  const ownPlan = covered ? billing.own_plan : null;
  const paid = (billing.plan === "private" || billing.plan === "connected") && !onTrial;
  const founding = billing.plan === "founding";
  // A bank payment still clearing (October 28, 2026): buying waits for it, as the server does.
  const clearing = billing.payment_pending === true;
  // A downgrade opens 30 days after the plan started or last changed (October 17, 2026).
  const downFrom = billing.downgrade_from ? formatDate(billing.downgrade_from) : null;
  const isDown = (plan: CheckoutPlan, iv: Interval) =>
    paid &&
    plan !== "founding" &&
    (TIERS[plan] < TIERS[billing.plan as "private" | "connected"] ||
      (plan === billing.plan && billing.interval === "yearly" && iv === "monthly"));
  const saving = yearlySavingPercent(billing);
  const foundingOnce = Number(billing.founding.one_time_cents ?? 0);
  const foundingYears = Number(billing.founding.term_years ?? 4);
  // Owner, October 14, 2026: the value is the saving against 4 years of Connected yearly.
  const connectedTerm = priceCents(billing, "connected", "yearly") * foundingYears;
  const foundingSaving = {
    cents: connectedTerm - foundingOnce,
    pct: connectedTerm ? Math.round((100 * (connectedTerm - foundingOnce)) / connectedTerm) : 0,
  };
  const cap = billing.founding.cap ? String(billing.founding.cap) : "";
  const capNumber = Number(billing.founding.cap ?? 0);
  const left = Number(billing.founding.left ?? capNumber);
  const perLabel = interval === "yearly" ? "a year" : "a month";
  const perMonthYearly = (plan: string) =>
    formatCents(Math.round(priceCents(billing, plan, "yearly") / 12));

  // The website's words for each plan (apps/site/src/data/plans.ts), one line and a list with
  // icons rather than a paragraph (October 23, 2026).
  const plans: Array<{
    key: CheckoutPlan;
    name: string;
    value: string;
    features: string[];
    popular?: boolean;
  }> = [
    {
      key: "private",
      name: "Private",
      popular: true,
      value: "Every account. Never linked. Fully private.",
      features: [
        "Unlimited statement accounts",
        "4 jars & goals",
        "Start your own challenges",
        "Encrypted backup & sync",
        "Statements read on your device",
      ],
    },
    {
      key: "connected",
      name: "Connected",
      value: "Banks and cards update themselves.",
      features: [
        "Link 3 banks or cards, read-only",
        "10 jars & goals",
        "Couples: one price covers you both",
        "Everything in Private",
      ],
    },
  ];
  const access = limits?.access ?? null;
  // Each end in its own words, the same as its email (invariant 73).
  const lapsed =
    access?.state === "lapsed" && access.delete_at
      ? endNotice(billing.ended, formatDate(access.delete_at), Boolean(billing.shared))
      : null;
  /** Yearly against twelve monthly payments, for the badge (owner, October 14, 2026). */
  const yearlySave = (plan: CheckoutPlan) => {
    const monthly12 = priceCents(billing, plan, "monthly") * 12;
    return monthly12
      ? Math.round((100 * (monthly12 - priceCents(billing, plan, "yearly"))) / monthly12)
      : 0;
  };

  return (
    <>
      <ScreenHeader title="Your plan" actions={null} back="/me/account" />
      {status ? (
        <p className="auth__hint plan-status" role="status">
          {status}
        </p>
      ) : null}
      {!billing.available ? (
        <Card>
          <p>Plans aren't on sale yet.</p>
        </Card>
      ) : null}
      {lapsed ? (
        <div className="plan-alert" role="alert">
          <p className="plan-alert__title">{lapsed.title}</p>
          <p>{lapsed.body}</p>
          <Link to="/me/data" className="plan-alert__link">
            Download my data
          </Link>
        </div>
      ) : null}
      {access?.state === "paused" ? (
        <div className="plan-alert" role="alert">
          <p className="plan-alert__title">Your plan is paused</p>
          <p>
            Your bank told us a payment is being disputed, so the plan is paused for now. Nothing is
            deleted. If the dispute is withdrawn or closed in our favour, it comes back by itself.
            Your data stays here, and you can download it any time.
          </p>
          <Link to="/me/data" className="plan-alert__link">
            Download my data
          </Link>
        </div>
      ) : null}
      {access?.state === "ended" ? (
        <div className="plan-alert" role="alert">
          <p className="plan-alert__title">Your plan has ended</p>
          <p>
            Your bank decided the payment dispute in your favour and returned the money, so this
            plan has ended and a new one can't be bought on this account. Nothing is deleted: your
            account stays open, and you can download your data or delete the account whenever you
            like.
          </p>
          <Link to="/me/data" className="plan-alert__link">
            Download my data
          </Link>
        </div>
      ) : null}
      {billing.payment_pending ? (
        <div className="plan-alert" role="status">
          <p className="plan-alert__title">Your bank payment is on its way</p>
          <p>
            Bank payments take up to 4 business days to clear. Your plan starts as soon as it does,
            and we'll email you if it doesn't go through. Plans can be chosen again once it clears.
          </p>
        </div>
      ) : null}
      <Card tone="accent" as="section" aria-label="Current plan">
        <p className="sk-card__eyebrow">Current plan</p>
        <Word>
          {access?.state === "paused"
            ? "Paused"
            : access?.state === "lapsed" || access?.state === "ended"
              ? "Ended"
              : access?.state === "trial"
                ? "Trial"
                : billing.payment_pending
                  ? "Pending"
                  : billing.cancel_at_period_end && !covered
                    ? "Ending"
                    : access?.state === "choose" && access.trial_used
                      ? "None"
                      : billing.plan === "free"
                        ? "Free"
                        : "Active"}
        </Word>
        <p className="sk-card__hero sk-card__hero--empty">
          {access?.state === "trial"
            ? `${access.plan === "connected" ? "Connected" : "Private"} trial`
            : access?.state === "choose" && access.trial_used
              ? "No plan yet"
              : billing.label}
          {billing.interval && !covered ? ` · ${billing.interval}` : ""}
        </p>
        <p>{currentLine(billing, access)}</p>
        {ownPlan ? (
          <>
            <p>
              {billing.cancel_at_period_end
                ? `Covered by ${billing.shared_by ?? "your partner"}'s ${billing.label}. Your own ${PLAN_LABELS[ownPlan]} ends ${billing.renews_at ? `on ${formatDate(billing.renews_at)}` : "at the end of its paid period"}.`
                : `Covered by ${billing.shared_by ?? "your partner"}'s ${billing.label}. You also pay for ${PLAN_LABELS[ownPlan]}${billing.renews_at ? ` (renews ${formatDate(billing.renews_at)})` : ""} — you can stop it.`}
            </p>
            {billing.cancel_at_period_end ? null : billing.source === "stripe" ? (
              <Button size="sm" variant="secondary" onClick={() => void openCancel()}>
                Stop my {PLAN_LABELS[ownPlan]}
              </Button>
            ) : (
              <p className="auth__hint">
                {billing.source === "apple"
                  ? "You bought it in the App Store: stop it there, in your subscriptions."
                  : "You bought it in Google Play: stop it there, in your subscriptions."}
              </p>
            )}
          </>
        ) : null}
        {billing.shared === "holder" &&
        (access?.state === "subscribed" || access?.state === "trial") ? (
          <p>This plan covers you and your partner in your household: one price for both.</p>
        ) : null}
        {billing.shared && access?.state === "lapsed" ? (
          <p>It ended for both of you. Either of you can pick a plan that covers you both.</p>
        ) : null}
        {credit && credit.credit_cents > 0 ? (
          <p>{formatCents(credit.credit_cents)} credit on your account, used for your next bills</p>
        ) : null}
        {billing.tester_plan ? (
          <p>Testing for free: not billed. Your real plan is unchanged.</p>
        ) : null}
        {limits ? <p className="sk-card__eyebrow">{planLine(limits)}</p> : null}
      </Card>

      {billing.tester ? (
        <Card as="section" aria-label="Tester tools">
          <p className="sk-card__eyebrow">Tester tools · only you see this</p>
          <p>
            Use any plan for free to test it. Nothing is charged and Stripe isn't involved.
            Receipts, switching and cancelling below still act on your real plan.
          </p>
          <div className="tester-plans">
            {(["free", "private", "connected", "founding"] as const).map((plan) => (
              <Button
                key={plan}
                size="sm"
                variant={billing.tester_plan === plan ? "primary" : "secondary"}
                disabled={busy || billing.tester_plan === plan}
                onClick={() => void testAs(plan)}
              >
                {TESTER_NAMES[plan]}
              </Button>
            ))}
            {billing.tester_plan ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void testAs(null)}>
                Back to my real plan
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {native ? (
        <List card aria-label="Manage your plan">
          {paid && (billing.source === "apple" || billing.source === "google") ? (
            <ListRow
              label={
                billing.source === "apple" ? "Manage in the App Store" : "Manage in Google Play"
              }
              sublabel="Switch, renew or cancel on the store's own page"
              onClick={() => void openStoreSubscriptions()}
              chevron
            />
          ) : null}
          <ListRow
            label="Restore purchases"
            sublabel="Bought on this store account before? Bring the plan back"
            onClick={() => void restore()}
            chevron
          />
        </List>
      ) : null}
      {!native && paid && billing.has_customer ? (
        <List card aria-label="Manage your plan">
          {covered ? null : billing.interval === "yearly" ? (
            <ListRow
              label="Switch to monthly"
              sublabel={
                downFrom
                  ? `Available from ${downFrom}`
                  : `${formatCents(priceCents(billing, billing.plan, "monthly"))} a month · the rest of this year becomes credit`
              }
              onClick={() =>
                downFrom
                  ? setLockedFor(`${billing.label} monthly`)
                  : void choose(billing.plan as CheckoutPlan, "monthly")
              }
              chevron
            />
          ) : (
            <ListRow
              label="Switch to yearly"
              sublabel={`${formatCents(priceCents(billing, billing.plan, "yearly"))} a year · save ${saving}%`}
              onClick={() => void choose(billing.plan as CheckoutPlan, "yearly")}
              chevron
            />
          )}
          <ListRow
            label="Receipts & invoices"
            sublabel="Opens the secure billing page"
            onClick={() => portal("Opening your billing page")}
            chevron
          />
          {billing.cancel_at_period_end ? (
            <ListRow
              label="Keep my plan"
              sublabel={
                billing.renews_at
                  ? `Ends ${formatDate(billing.renews_at)} unless you keep it`
                  : "Undo the cancellation"
              }
              onClick={() => void setRenewal(null)}
              chevron
            />
          ) : (
            <ListRow label="Cancel plan" onClick={() => void openCancel()} chevron />
          )}
        </List>
      ) : null}

      {!native && !paid && billing.has_customer ? (
        // After a plan ends, on a trial with a card saved, or as a Founding member: the
        // receipts are still there (October 28, 2026).
        <List card aria-label="Receipts">
          <ListRow
            label="Receipts & invoices"
            sublabel="Opens the secure billing page"
            onClick={() => portal("Opening your billing page")}
            chevron
          />
        </List>
      ) : null}

      {access?.state === "ended" || lapsed?.offer === false ? null : billing.shared === "covered" &&
        access?.state === "subscribed" ? (
        <Card as="section" aria-label="Shared plan">
          <p>
            Your plan comes with {billing.shared_by ?? "your partner"}'s, so there's nothing to buy.
            If it ends, it ends for both of you, and we'll email you both first.
          </p>
        </Card>
      ) : founding ? (
        <Card>
          <p>Before your term ends you'll choose a plan. Nothing is deleted either way.</p>
        </Card>
      ) : (
        <>
          <h2 className="section-title">Choose a plan</h2>
          <fieldset className="segmented" style={{ border: 0, margin: "0 0 12px" }}>
            <legend className="sr-only">Billing period</legend>
            {(
              [
                ["yearly", saving > 0 ? `Yearly · save up to ${saving}%` : "Yearly"],
                ["monthly", "Monthly"],
              ] as const
            ).map(([value, label]) => (
              <label className="segmented__option" key={value}>
                <input
                  className="segmented__input"
                  type="radio"
                  name={`${ids}-interval`}
                  value={value}
                  checked={interval === value}
                  onChange={() => setInterval(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="plan-list">
            {plans.map((p) => {
              // A trial is not a paid plan: its own plan stays choosable, to add a card.
              // The same plan on the other billing period is a switch, not the current plan.
              const current =
                billing.plan === p.key &&
                access?.state !== "trial" &&
                (!paid || billing.interval === interval);
              const locked = downFrom !== null && isDown(p.key, interval);
              const price = priceCents(billing, p.key, interval);
              const save = interval === "yearly" ? yearlySave(p.key) : 0;
              return (
                <Card as="article" key={p.key} aria-label={p.name}>
                  <div className="plan-card">
                    <div className="plan-card__top">
                      <span className="plan-card__name">{p.name}</span>
                      {current ? (
                        <Chip tone="success">Current</Chip>
                      ) : p.popular ? (
                        <Chip tone="accent">Most popular</Chip>
                      ) : null}
                      {save > 0 ? <span className="plan-card__save">Save {save}%</span> : null}
                    </div>
                    <p className="plan-card__price">
                      {formatCents(price)}
                      <span className="plan-card__per"> {perLabel}</span>
                    </p>
                    {interval === "yearly" ? (
                      <p className="plan-card__sub">
                        {perMonthYearly(p.key)} a month, billed yearly
                      </p>
                    ) : null}
                    <p className="plan-card__value">{p.value}</p>
                    <ul className="plan-card__features">
                      {p.features.map((f) => (
                        <li key={f}>
                          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                            <path
                              d="M5 12.5l4.5 4.5L19 7.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          {f}
                        </li>
                      ))}
                    </ul>
                    <Button
                      block
                      variant={current || locked ? "secondary" : "primary"}
                      disabled={current || busy || !billing.available || clearing}
                      onClick={() =>
                        locked
                          ? setLockedFor(interval === "monthly" ? `${p.name} monthly` : p.name)
                          : void choose(p.key)
                      }
                    >
                      {current
                        ? "Current plan"
                        : locked
                          ? `Switch to ${p.name} from ${downFrom}`
                          : `Choose ${p.name}`}
                    </Button>
                  </div>
                </Card>
              );
            })}
            {native ? (
              <Card as="article" aria-label="Founding member">
                <p className="sk-card__eyebrow">Founding member</p>
                <p>
                  The one-time Founding offer (
                  {formatCents(Number(billing.founding.one_time_cents ?? 0))},{" "}
                  {String(billing.founding.term_years ?? 4)} years of Connected) is sold on the
                  website only: the stores have no 4-year term. Buy it there and it works here.
                </p>
              </Card>
            ) : (
              <Card as="article" aria-label="Founding member">
                <div className="plan-card">
                  <div className="plan-card__top">
                    <span className="plan-card__name">Founding member</span>
                    <Chip tone="warning">Limited</Chip>
                  </div>
                  <p className="plan-card__price">
                    {formatCents(Number(billing.founding.one_time_cents ?? 0))}
                    <span className="plan-card__per">
                      {" "}
                      once · {String(billing.founding.term_years ?? 4)} years of Connected
                    </span>
                  </p>
                  <p className="plan-card__value">
                    {foundingSaving.pct}% savings vs the annual Connected plan
                  </p>
                  <p className="plan-card__sub">
                    Save {formatWholeDollars(foundingSaving.cents)} over{" "}
                    {String(billing.founding.term_years ?? 4)} years · one payment, no renewal
                  </p>
                  {cap ? (
                    <div className="founding-left">
                      <ProgressBar
                        fraction={capNumber ? (capNumber - left) / capNumber : 0}
                        label="Founding places taken"
                        valueText={`${left} of ${cap} places left`}
                        tone="warning"
                      />
                      <p>
                        <strong>{left}</strong> of {cap} places left
                      </p>
                    </div>
                  ) : null}
                  <Button
                    block
                    disabled={busy || !billing.available || clearing || (cap !== "" && left <= 0)}
                    onClick={() => void choose("founding")}
                  >
                    {cap !== "" && left <= 0 ? "All places taken" : "Become a Founding member"}
                  </Button>
                </div>
              </Card>
            )}
          </div>
          {/* The billing terms, every sentence kept, one per line (October 28, 2026). */}
          <section className="terms" aria-labelledby="terms-h">
            <h2 className="sk-card__title" id="terms-h">
              How billing works
            </h2>
            <ul className="terms__list">
              <li>Prices in US dollars.</li>
              <li>
                A yearly plan renews each year and a monthly plan each month until you cancel, which
                you can do here any time.
              </li>
              <li>Switching up costs only the difference for the time left.</li>
              <li>
                Switching down happens at once, from 30 days after you start or switch, and the
                unused part becomes credit for your next bills.
              </li>
              <li>Cancelling runs to the end of the paid period and refunds nothing.</li>
              <li>
                Delete your account and we keep the current month; on a yearly plan the months used,
                this one included, cost the monthly price and the rest of the year comes back, less
                Stripe's fee (2.9% + 30¢ on a card, 0.8% up to $5 on a bank account).
              </li>
              <li>
                Changing plans never deletes anything: jars past the smaller plan's limit become
                read-only.
              </li>
              <li>Shortfall alerts, security and your data rights are the same on every plan.</li>
            </ul>
          </section>
        </>
      )}

      <PlanHistory refreshKey={billing} />

      <Sheet open={pending !== null} onClose={() => setPending(null)} title="Before you subscribe">
        {pending ? (
          <div className="consent">
            <ConsentPoints consent={pending.consent} />
            <label className="consent__agree" htmlFor={agreeId}>
              <input
                id={agreeId}
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>{pending.consent.agreement}</span>
            </label>
            <Button block disabled={!agreed || busy} onClick={() => void proceed(pending)}>
              Continue to secure payment
            </Button>
          </div>
        ) : null}
      </Sheet>

      <Sheet open={change !== null} onClose={() => setChange(null)} title="Change your plan">
        {change ? (
          <div className="consent">
            <ConsentPoints consent={change.preview.consent} />
            <label className="consent__agree" htmlFor={agreeId}>
              <input
                id={agreeId}
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              <span>{change.preview.consent.agreement}</span>
            </label>
            <Button block disabled={!agreed || busy} onClick={() => void confirmChange()}>
              {change.preview.due_now_cents > 0
                ? `Pay ${formatCents(change.preview.due_now_cents)} and switch`
                : "Switch now"}
            </Button>
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={lockedFor !== null}
        onClose={() => setLockedFor(null)}
        title={`Switch to ${lockedFor ?? ""} from ${downFrom ?? ""}`}
      >
        <div className="plan-lock">
          <p className="plan-lock__value">You lose nothing by waiting.</p>
          <p>Keep {billing.label} until then; unused time becomes credit.</p>
        </div>
        <Button block onClick={() => setLockedFor(null)}>
          Got it
        </Button>
      </Sheet>

      <Sheet
        open={cancelConsent !== null}
        onClose={() => setCancelConsent(null)}
        title="If you cancel"
      >
        <ul className="cancel-points">
          {(cancelConsent?.points ?? []).map((point) => (
            <li key={point.text}>
              <strong>{point.head}</strong>
              <span>{point.text}</span>
            </li>
          ))}
        </ul>
        <label className="consent__agree" htmlFor={cancelAgreeId}>
          <input
            id={cancelAgreeId}
            type="checkbox"
            checked={cancelAgreed}
            onChange={(e) => setCancelAgreed(e.target.checked)}
          />
          <span>{cancelConsent?.agreement}</span>
        </label>
        <Button block onClick={() => setCancelConsent(null)}>
          Keep {billing.label}
        </Button>
        <Button
          block
          variant="ghost"
          disabled={busy || !cancelAgreed}
          onClick={() => {
            const consent = cancelConsent;
            setCancelConsent(null);
            void setRenewal(consent);
          }}
        >
          <span style={cancelAgreed ? { color: "var(--c-danger)" } : undefined}>Cancel plan</span>
        </Button>
      </Sheet>
    </>
  );
}

type ConsentKind = NonNullable<ConsentText["points"][number]["icon"]>;

const PLAN_NAMES = { private: "Private", connected: "Connected" } as const;
const PLAN_LABELS = { ...PLAN_NAMES, founding: "Founding" } as const;

const TESTER_NAMES = {
  free: "No plan",
  private: "Private",
  connected: "Connected",
  founding: "Founding",
} as const;

const TIERS = { private: 1, connected: 2 } as const;

/** The server's lines for an offer, each with its icon (October 28, 2026: never written here). */
function ConsentPoints({ consent }: { consent: ConsentText }) {
  return (
    <ul className="consent__points">
      {consent.points.map((point) => (
        <li key={point.text}>
          <span className="consent__icon" aria-hidden="true">
            {point.icon ? <ConsentIcon kind={point.icon} /> : null}
          </span>
          <span>{point.text}</span>
        </li>
      ))}
    </ul>
  );
}

function ConsentIcon({ kind }: { kind: ConsentKind }) {
  const d: Record<ConsentKind, string> = {
    price:
      "M12 3v18M16.5 7.5c0-1.7-2-3-4.5-3s-4.5 1.3-4.5 3 2 2.6 4.5 3.2 4.5 1.5 4.5 3.3-2 3-4.5 3-4.5-1.3-4.5-3",
    renew:
      "M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7",
    cancel: "M6 4h12v16H6zM9 9l6 6M15 9l-6 6",
    card: "M3 7h18v11H3zM3 11h18M7 15h3",
    term: "M5 5h14v15H5zM5 9h14M9 3v4M15 3v4",
    refund: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
    unlink: "M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1",
  };
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={d[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
