import { GROUPS, groupTitle, ENTRIES as SETTINGS } from "../settings/settingsIndex.ts";

/**
 * Everything search can open (owner decision, November 16, 2026): every screen and the main
 * actions, written by hand with the everyday words people type for them, plus every setting from
 * Me's index. One list, one way of matching (`searchEngine.ts`). The person's own data (entries,
 * jars, bills, tags, accounts) is searched separately on the device (`dataSearch.ts`).
 *
 * A new screen gets an entry here, or a reason in `NOT_SEARCHABLE`; `tests/unit/search.test.tsx`
 * fails otherwise, and opens every entry to check it lands where it says.
 */
export interface SearchEntry {
  /** Stable, for Recent (the only thing remembered: which place was opened, never the typing). */
  id: string;
  label: string;
  /** Where it lives, said first on the result ("Bills", "Me · Alerts"). */
  section: string;
  /** One short line of what it is. */
  line: string;
  path: string;
  /** The id of the row to scroll to and flash once the screen has rendered. */
  target?: string;
  words: string;
  kind: "place" | "action" | "setting";
  /** A plan feature it needs; without it the result says so and opens the plans instead. */
  needs?: "bank_links" | "backup" | "household" | "groups_create";
  /** Only in a browser tab (installing is done once installed). */
  browserOnly?: boolean;
}

const PLACES: SearchEntry[] = [
  {
    id: "home",
    label: "Home",
    section: "Home",
    line: "This month at a glance",
    path: "/",
    words: "home dashboard start overview kept month summary next move",
    kind: "place",
  },
  {
    id: "money",
    label: "Money in & out",
    section: "Home",
    line: "In, out and kept, by category",
    path: "/money",
    words: "money in out income spending spent kept categories cash flow month earned",
    kind: "place",
  },
  {
    id: "entries",
    label: "Your entries",
    section: "Money in & out",
    line: "Every transaction, newest first",
    path: "/money?view=transactions",
    words: "entries transactions list history purchases charges payments ledger",
    kind: "place",
  },
  {
    id: "add-entry",
    label: "Add an entry",
    section: "Add",
    line: "Log money in or out by hand",
    path: "/add",
    words: "add new entry transaction expense income log record spend manual",
    kind: "action",
  },
  {
    id: "add-receipt",
    label: "Add a receipt",
    section: "Add",
    line: "A photo kept with its entry",
    path: "/add?with=receipt",
    words: "receipt photo picture camera scan paper",
    kind: "action",
  },
  {
    id: "import",
    label: "Import a statement",
    section: "Add",
    line: "CSV, OFX, QFX or PDF from your bank",
    path: "/import",
    words: "import upload statement bank csv ofx qfx pdf file download transactions",
    kind: "action",
  },
  {
    id: "review",
    label: "Sort your spending",
    section: "Money in & out",
    line: "Give uncategorized entries a category",
    path: "/review",
    words: "sort review uncategorized categorize category unsorted fix label",
    kind: "place",
  },
  {
    id: "tags",
    label: "Tags",
    section: "Money in & out",
    line: "Entries you tagged, with totals",
    path: "/tags",
    words: "tags tag hashtag label notes trip project",
    kind: "place",
  },
  {
    id: "recap",
    label: "Weekly recap",
    section: "Home",
    line: "The last seven days",
    path: "/recap",
    words: "weekly recap week summary seven days last week",
    kind: "place",
  },
  {
    id: "setup",
    label: "Make Qash yours",
    section: "Home",
    line: "Setup steps, all optional",
    path: "/setup",
    words: "setup set up getting started onboarding steps begin",
    kind: "place",
  },
  {
    id: "budget",
    label: "Budget",
    section: "Budget",
    line: "Your plan for the month",
    path: "/budget",
    words: "budget plan 50 30 20 zero based needs wants save take home limit spending plan",
    kind: "place",
  },
  {
    id: "goals",
    label: "Jars & goals",
    section: "Goals",
    line: "Saving, paying off, spending less",
    path: "/goals",
    words: "goals jars savings save saving target pot fund",
    kind: "place",
  },
  {
    id: "new-goal",
    label: "Start a jar or goal",
    section: "Goals",
    line: "Save, pay off, spend less or a habit",
    path: "/goals/new",
    words: "new jar goal create start save for vacation car house wedding habit pay off",
    kind: "action",
  },
  {
    id: "emergency",
    label: "Emergency fund",
    section: "Goals",
    line: "How many months you're covered",
    path: "/emergency",
    words: "emergency fund rainy day safety net runway months covered savings cushion",
    kind: "place",
  },
  {
    id: "challenges",
    label: "Challenges",
    section: "Goals",
    line: "Save together, ranked by percent",
    path: "/goals?tab=challenges",
    words: "challenges challenge group friends compete leaderboard together",
    kind: "place",
  },
  {
    id: "new-challenge",
    label: "Start a challenge",
    section: "Goals",
    line: "Pick a type and invite people",
    path: "/groups/new",
    words: "new challenge start create group no spend weekend 52 week dining",
    kind: "action",
    needs: "groups_create",
  },
  {
    id: "join-challenge",
    label: "Join a challenge",
    section: "Goals",
    line: "With a code someone sent you",
    path: "/groups/join",
    words: "join challenge code invite stk",
    kind: "action",
  },
  {
    id: "insights",
    label: "Insights",
    section: "Insights",
    line: "Every picture of your money",
    path: "/insights",
    words: "insights charts reports analysis trends graphs stats",
    kind: "place",
  },
  {
    id: "spending",
    label: "Biggest & most often",
    section: "Insights",
    line: "Top amounts and merchants",
    path: "/insights/spending",
    words: "biggest largest top spending merchants most often frequent where money goes",
    kind: "place",
  },
  {
    id: "fixed-flexible",
    label: "Fixed vs flexible",
    section: "Insights",
    line: "Bills against the rest",
    path: "/insights/fixed-flexible",
    words: "fixed flexible bills rest kept rate discretionary essentials",
    kind: "place",
  },
  {
    id: "later",
    label: "Later",
    section: "Insights",
    line: "Savings by the age you choose",
    path: "/insights/later",
    words: "later retirement retire future savings age growth compound invest 401k ira",
    kind: "place",
  },
  {
    id: "what-if",
    label: "What if",
    section: "Insights",
    line: "Move one thing, see what changes",
    path: "/what-if",
    words: "what if scenario calculator try change simulate pay extra spend less",
    kind: "place",
  },
  {
    id: "month-review",
    label: "Your month",
    section: "Insights",
    line: "Last month, and one change to try",
    path: "/month-review",
    words: "your month review last month look back monthly report one change",
    kind: "place",
  },
  {
    id: "net-worth",
    label: "Net worth",
    section: "Insights",
    line: "What you own minus what you owe",
    path: "/net-worth",
    words: "net worth own owe assets debts wealth total balance house car",
    kind: "place",
  },
  {
    id: "credit-habits",
    label: "Credit habits",
    section: "Insights",
    line: "On-time payments and limit used",
    path: "/credit-habits",
    words: "credit habits card score on time utilization limit used paid in full",
    kind: "place",
  },
  {
    id: "forecast",
    label: "Next 30 days",
    section: "Insights",
    line: "Your estimated balance ahead",
    path: "/forecast",
    words: "next 30 days forecast upcoming balance ahead future shortfall cushion low calendar",
    kind: "place",
  },
  {
    id: "safe-to-spend",
    label: "Safe to spend",
    section: "Next 30 days",
    line: "Room until your next pay period",
    path: "/forecast",
    words: "safe to spend how much can i spend left room allowance afford daily",
    kind: "place",
  },
  {
    id: "bills",
    label: "Bills",
    section: "Bills",
    line: "What's due, and when",
    path: "/bills",
    words: "bills due recurring rent utilities payments upcoming monthly",
    kind: "place",
  },
  {
    id: "debt",
    label: "Debt payoff",
    section: "Bills",
    line: "Your debt-free date and plan",
    path: "/bills?tab=debt",
    words: "debt payoff loan loans credit card balance interest apr debt free avalanche snowball",
    kind: "place",
  },
  {
    id: "subscriptions",
    label: "Subscriptions",
    section: "Bills",
    line: "What renews, and how to cancel",
    path: "/subscriptions",
    words: "subscriptions streaming netflix spotify cancel renew renewal memberships trial",
    kind: "place",
  },
  {
    id: "splits",
    label: "Split bills",
    section: "Splits",
    line: "Who owes whom in each group",
    path: "/splits",
    words:
      "split splits splitwise share bills owe owed friends roommates housemates trip settle up",
    kind: "place",
  },
  {
    id: "new-split-group",
    label: "Start a split group",
    section: "Splits",
    line: "For a home, a trip or a dinner",
    path: "/splits/new",
    words: "new split group create start trip house rent roommates",
    kind: "action",
  },
  {
    id: "split-one",
    label: "Split with one person",
    section: "Splits",
    line: "Just you and one friend",
    path: "/splits/one",
    words: "split one person friend partner two of us",
    kind: "action",
  },
  {
    id: "split-entry",
    label: "Split something you paid",
    section: "Splits",
    line: "Add a bill to one of your groups",
    path: "/splits/add",
    words: "split add bill paid dinner share expense",
    kind: "action",
  },
  {
    id: "link-device",
    label: "Link a device",
    section: "Me",
    line: "Approve a sign-in on a computer",
    path: "/link",
    words: "link device computer laptop sign in phone qr code approve scan",
    kind: "action",
  },
];

const GROUP_ENTRIES: SearchEntry[] = GROUPS.map((g) => ({
  id: `group:${g.key}`,
  label: g.title,
  section: "Me",
  line: g.blurb,
  path: g.path,
  words: g.blurb,
  kind: "setting",
}));

/** Settings that need a plan feature, by label in Me's index. */
const SETTING_NEEDS: Readonly<Record<string, SearchEntry["needs"]>> = {
  "Linked banks & cards": "bank_links",
  "Backup & sync": "backup",
  "Couples & household": "household",
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const SETTING_ENTRIES: SearchEntry[] = SETTINGS.filter(
  // Me's own copy of these lives in PLACES above, with the screen that does the thing.
  (s) => s.label !== "Link a device" && s.label !== "Split bills",
).map((s) => ({
  id: `setting:${slug(s.label)}`,
  label: s.label,
  section: `Me · ${groupTitle(s.group)}`,
  line: "",
  path: s.path,
  target: s.target,
  words: s.words,
  kind: "setting",
  needs: SETTING_NEEDS[s.label],
  browserOnly: s.label === "Install Qash" || undefined,
}));

export const SEARCH_ENTRIES: readonly SearchEntry[] = [
  ...PLACES,
  ...GROUP_ENTRIES,
  ...SETTING_ENTRIES,
];

/** Shown before anything is typed: the things people do most. */
export const SHORTCUT_IDS: readonly string[] = [
  "add-entry",
  "import",
  "new-goal",
  "split-entry",
  "safe-to-spend",
];

/**
 * Every app route that search does not open, and why. A route that is neither here nor the
 * path of an entry fails `tests/unit/search.test.tsx`.
 */
export const NOT_SEARCHABLE: Readonly<Record<string, string>> = {
  "/welcome": "before sign-in",
  "/signin": "before sign-in",
  "/signin/code": "before sign-in",
  "/signin/phone": "before sign-in",
  "/signup/passkey": "part of signing up",
  "/deleted": "shown once, after deleting the account",
  "/kept": "shown only when a plan has ended",
  "/install": "the website's link; Install Qash in Me is the way from inside",
  "/start": "picking a trial, once",
  "/goals/:id": "one jar: found by searching the person's own data (dataSearch.ts)",
  "/groups/:id":
    "one challenge, from Challenges; its jar is found by searching the person's own data",
  "/splits/:id": "one split group, from Split bills; group names aren't searched yet",
  "/splits/:id/bills/new": "inside a split group",
  "/splits/:id/bills/:billId": "one bill inside a split group",
  "/splits/join": "opened from an invite link",
  "/household/join": "opened from an invite link",
  "/tags/:tag": "one tag: found by searching the person's own data",
  "/entries/:id": "one entry: found by searching the person's own data",
  "/entries": "old link; Your entries is the way",
  "/learn": "old link; Insights is the way",
  "/learn/:slug": "old link; Insights is the way",
  "/search/entries": "the full list behind a search's See all, and a merchant's entries",
  "/me/linking/done": "where the bank returns after linking",
  "*": "not a page",
};
