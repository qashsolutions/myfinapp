import { pushSettingsTitle } from "../../moments/catalog.ts";

/** The groups on Me, in order. Each opens its own screen (spec "Settings (PWA)"). */
export interface SettingsGroup {
  key: string;
  title: string;
  blurb: string;
  path: string;
}

export const GROUPS: SettingsGroup[] = [
  { key: "account", title: "Account & plan", blurb: "Plan, name, email", path: "/me/account" },
  {
    key: "security",
    title: "Sign-in & security",
    blurb: "Passkeys, devices, auto-lock, backup",
    path: "/me/security",
  },
  {
    key: "data",
    title: "Money & data",
    blurb: "Accounts, banks, receipts, export",
    path: "/me/data",
  },
  {
    key: "alerts",
    title: "Alerts",
    blurb: "What you get, when, how often",
    path: "/me/notifications",
  },
  {
    key: "groups",
    title: "Groups & household",
    blurb: "Challenges, your partner",
    path: "/me/groups",
  },
  { key: "look", title: "Look & feel", blurb: "App look, dark mode, sounds", path: "/me/look" },
  { key: "help", title: "Help & legal", blurb: "Contact, privacy, terms", path: "/me/help" },
];

/**
 * One searchable setting: where it lives, the element to highlight there (`target`, an id),
 * and everyday words people type for it ("logout", "password", "theme").
 */
export interface SettingEntry {
  label: string;
  group: string;
  path: string;
  target?: string;
  words: string;
}

const ALERT_WORDS: Record<string, string> = {
  upcoming_expense: "bills due reminder upcoming recurring",
  shortfall_risk: "low balance shortfall forecast buffer cushion daily summary digest",
  challenge_checkin: "challenge check-in daily reminder",
  goal_behind_pace: "goal behind pace jar",
  budget_pace: "budget category line bucket plan close over spending limit percent",
  milestone_reached: "milestone jar goal reached daily summary digest",
  group_activity: "group challenge joins members daily summary digest",
  weekly_recap: "weekly recap summary email",
};

export const ENTRIES: SettingEntry[] = [
  {
    label: "Your plan",
    group: "account",
    path: "/me/plan",
    words:
      "plan subscription subscribe price cancel refund trial upgrade downgrade switch billing receipts invoices card payment founding",
  },
  {
    label: "Your name",
    group: "account",
    path: "/me/account",
    target: "set-name",
    words: "name profile display",
  },
  { label: "Change email", group: "account", path: "/me/email", words: "email address" },
  {
    label: "Log out",
    group: "account",
    path: "/me",
    target: "set-account",
    words: "logout log off sign out signout exit",
  },
  {
    label: "Delete account",
    group: "account",
    path: "/me/delete",
    words: "delete close remove erase account",
  },
  {
    label: "Passkeys",
    group: "security",
    path: "/me/security",
    words: "passkey password face touch id fingerprint biometrics login sign in",
  },
  {
    label: "Active devices",
    group: "security",
    path: "/me/security",
    words: "devices sessions phones computers signed in",
  },
  {
    label: "Recent activity",
    group: "security",
    path: "/me/security",
    words: "activity history sign-ins failed attempts",
  },
  {
    label: "Auto-lock",
    group: "security",
    path: "/me/security",
    words: "lock timeout idle minutes",
  },
  {
    label: "Backup & sync",
    group: "security",
    path: "/me/security",
    words: "backup sync restore recovery key encrypted devices",
  },
  {
    label: "Accounts & imports",
    group: "data",
    path: "/me/accounts",
    words: "accounts balances statements import upload csv ofx pdf",
  },
  {
    label: "Card payment due day",
    group: "data",
    path: "/me/accounts",
    words: "credit card due day due date payment on time habits",
  },
  {
    label: "Credit habits guide",
    group: "data",
    path: "/credit-habits",
    words: "credit card limit used utilization guide percent 30 due day adjust",
  },
  {
    label: "Debt payoff extra and order",
    group: "data",
    path: "/bills?tab=debt",
    words:
      "debt payoff extra monthly order highest rate smallest balance avalanche snowball adjust",
  },
  {
    label: "Budget alerts by line",
    group: "data",
    path: "/budget",
    words: "budget alert line category bucket off tell me at close plan adjust",
  },
  {
    label: "Categories",
    group: "data",
    path: "/me/categories",
    words:
      "categories category rename add new own custom needs wants save hide remove rules names merchant",
  },
  {
    label: "Subscription check",
    group: "data",
    path: "/subscriptions",
    words:
      "subscriptions still using ask again days renewal heads up reminder adjust interval kind streaming",
  },
  {
    label: "Linked banks & cards",
    group: "data",
    path: "/me/linking",
    words: "bank card link connect disconnect plaid credit",
  },
  {
    label: "Receipt photos",
    group: "data",
    path: "/me/data",
    target: "set-receipts",
    words: "receipts photos retention keep",
  },
  {
    label: "Storage on this device",
    group: "data",
    path: "/me/data",
    target: "set-storage",
    words: "storage space device browser entries",
  },
  {
    label: "Download all my data",
    group: "data",
    path: "/me/data",
    target: "set-export",
    words: "export download zip copy data",
  },
  {
    label: "Push notifications",
    group: "alerts",
    path: "/me/notifications",
    target: "alerts-push",
    words: "push notifications turn on off device",
  },
  ...Object.entries(ALERT_WORDS).map(([kind, words]) => ({
    label: pushSettingsTitle(kind),
    group: "alerts",
    path: "/me/notifications",
    target: `alerts-${kind}`,
    words: `alert notification ${words}`,
  })),
  {
    label: "How often",
    group: "alerts",
    path: "/me/notifications",
    target: "alerts-often",
    words: "frequency often most per day limit maximum quiet hours night pause mute snooze",
  },
  {
    label: "Challenges & members",
    group: "groups",
    path: "/goals",
    words: "groups challenges invite code leave members",
  },
  {
    label: "Couples & household",
    group: "groups",
    path: "/me/household",
    words: "partner couple spouse household shared jars",
  },
  {
    label: "App look",
    group: "look",
    path: "/me/look",
    target: "set-look",
    words: "look theme style colours colors fonts modern minimal retro pastel anime illustrative",
  },
  {
    label: "Dark mode",
    group: "look",
    path: "/me/look",
    target: "set-display",
    words: "dark mode night light theme match system",
  },
  {
    label: "Simple layout",
    group: "look",
    path: "/me/look",
    target: "set-display",
    words: "simple layout plain larger",
  },
  {
    label: "Sounds",
    group: "look",
    path: "/me/look",
    target: "set-display",
    words: "sounds ka-ching audio",
  },
  {
    label: "Celebrations",
    group: "look",
    path: "/me/look",
    target: "set-display",
    words: "celebrations confetti animation motion",
  },
  {
    label: "Link a device",
    group: "security",
    path: "/me",
    target: "set-link-device",
    words: "link device computer laptop sign in phone qr code approve",
  },
  {
    label: "Customize Home",
    group: "look",
    path: "/",
    words: "customize home dashboard cards order drag rearrange hide show layout",
  },
  {
    label: "Your month on Home",
    group: "look",
    path: "/month-review?adjust=1",
    words: "your month review monthly look back home card days show hide start of month",
  },
  {
    label: "Fixed or flexible categories",
    group: "data",
    path: "/insights/fixed-flexible?adjust=1",
    words: "fixed flexible bills category treat rent phone kept rate room nice to have",
  },
  {
    label: "Install Qash",
    group: "look",
    path: "/me",
    target: "set-install",
    words: "install home screen app",
  },
  {
    label: "Help & contact",
    group: "help",
    path: "/me/help",
    words: "help support contact question problem",
  },
  { label: "Privacy policy", group: "help", path: "/me/help", words: "privacy policy" },
  { label: "Terms of service", group: "help", path: "/me/help", words: "terms conditions legal" },
  {
    label: "Data we never collect",
    group: "help",
    path: "/me/help",
    words: "data collect privacy",
  },
  { label: "Open-source licenses", group: "help", path: "/me/help", words: "licenses open source" },
];

export function groupTitle(key: string): string {
  return GROUPS.find((g) => g.key === key)?.title ?? "";
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Every word of the query must start a word of the entry (its label, group or everyday
 * words); labels that start with the query come first. Runs on the device only.
 */
export function searchSettings(query: string): SettingEntry[] {
  const q = norm(query);
  if (!q) return [];
  const terms = q.split(" ");
  const joined = q.replace(/ /g, "");
  const scored: [number, number, SettingEntry][] = [];
  ENTRIES.forEach((e, i) => {
    const label = norm(e.label);
    const words = `${label} ${norm(groupTitle(e.group))} ${norm(e.words)}`.split(" ");
    const hit = terms.every((t) => words.some((w) => w.startsWith(t)));
    const squashed = words.some((w) => w.length > 2 && joined.length > 3 && w.startsWith(joined));
    if (!hit && !squashed) return;
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
    scored.push([score, i, e]);
  });
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , e]) => e);
}
