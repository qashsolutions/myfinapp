import { readFileSync } from "node:fs";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { billingState } from "../../src/features/billing/billing.ts";
import { FREE_ENTITLEMENTS, resetEntitlements } from "../../src/features/billing/entitlements.ts";
import { createGoal } from "../../src/features/goals/useGoals.ts";
import {
  fakeMember,
  foundingBilling,
  freeBilling,
  installFakeApi,
  ME,
  mayasGroup,
  privateBilling,
  readySession,
} from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

async function seedGoals(n: number): Promise<string[]> {
  const db = openDb("u1");
  await seedDefaults(db);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(new Date(TODAY.getTime() + i * 60_000)); // made one after the other
    const goal = await createGoal(db, {
      kind: "save",
      title: `Jar ${i + 1}`,
      target_cents: 50000,
      target_days: null,
      label: null,
      category_id: null,
      start_date: "2026-10-01",
      end_date: "2027-03-01",
      baseline_cents: null,
      group_id: null,
    });
    ids.push(goal.id);
  }
  return ids;
}

async function agree(user: ReturnType<typeof userEvent.setup>, line: string) {
  const sheet = await screen.findByRole("dialog", { name: "Before you subscribe" });
  await user.click(within(sheet).getByRole("checkbox", { name: line }));
  await user.click(within(sheet).getByRole("button", { name: "Continue to secure payment" }));
}

describe("Plans & billing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    billingState.lastUrl = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the sheets show the server's lines and send them back unchanged", async () => {
    // Invariant: consent wording has one source, the server (October 28, 2026). Whatever it
    // says is what the sheet shows and what goes back; the app never writes or edits a line.
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession(), billing: freeBilling() });
    const fake = globalThis.fetch;
    const words = {
      version: "2026-10-24",
      points: [
        { icon: "price", text: "Words only the server wrote." },
        { icon: null, text: "A second line, also the server's." },
      ],
      lines: ["Words only the server wrote.", "A second line, also the server's."],
      agreement: "I agree to exactly these words.",
    };
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/api/billing/consent/purchase") {
        await fake(request); // recorded like any call
        return new Response(JSON.stringify(words), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return fake(request);
    };
    renderApp("/me/plan");
    const priv = await screen.findByRole("article", { name: "Private" });
    await user.click(within(priv).getByRole("button", { name: "Choose Private" }));
    const sheet = await screen.findByRole("dialog", { name: "Before you subscribe" });
    expect(
      within(sheet)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Words only the server wrote.", "A second line, also the server's."]);
    expect(sheet).not.toHaveTextContent("today, then every year");
    await user.click(within(sheet).getByRole("checkbox", { name: words.agreement }));
    await user.click(within(sheet).getByRole("button", { name: "Continue to secure payment" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === "/api/billing/checkout")?.body).toMatchObject({
        consent: {
          version: words.version,
          lines: words.lines,
          agreement: words.agreement,
          accepted: true,
        },
      }),
    );
    // The fake server did not write these words, so it refuses them, as the real one would.
    expect(
      await screen.findByText(
        "The terms changed since you opened them. Choose the plan again to see them.",
      ),
    ).toBeInTheDocument();
    expect(billingState.lastUrl).toBeNull();
  });

  it("the Free fallback on the device matches plans.yaml", () => {
    const yaml = readFileSync(
      `${process.cwd()}/../../services/api/app/rules_server/plans.yaml`,
      "utf8",
    );
    const free = yaml.split("\n  free:\n")[1]?.split("\n  private:\n")[0] ?? "";
    const value = (key: string) => free.match(new RegExp(`${key}: ([^\\n#]+)`))?.[1]?.trim();
    expect(value("goals_active_max")).toBe(String(FREE_ENTITLEMENTS.goals_active_max));
    expect(value("statement_accounts_max")).toBe(String(FREE_ENTITLEMENTS.statement_accounts_max));
    expect(value("groups_create")).toBe(String(FREE_ENTITLEMENTS.groups_create));
    expect(value("groups_join_max")).toBe(String(FREE_ENTITLEMENTS.groups_join_max));
    expect(value("bank_links_max")).toBe(String(FREE_ENTITLEMENTS.bank_links_max));
    expect(value("backup")).toBe(String(FREE_ENTITLEMENTS.backup));
    expect(value("household")).toBe(String(FREE_ENTITLEMENTS.household));
  });

  it("Free: prices, the period picker and Checkout for Private after a passkey check", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession(), billing: freeBilling() });
    renderApp("/me/plan");
    expect(await screen.findByRole("heading", { level: 1, name: "Your plan" })).toBeInTheDocument();
    const current = await screen.findByRole("region", { name: "Current plan" });
    expect(current).toHaveTextContent("Free");
    expect(current).toHaveTextContent(
      "2 jars and goals · 1 statement account · join 1 challenge at a time",
    );
    expect(screen.getByRole("radio", { name: "Yearly · save up to 44%" })).toBeChecked();
    const priv = screen.getByRole("article", { name: "Private" });
    expect(priv).toHaveTextContent("$20.00 a year");
    expect(priv).toHaveTextContent("$1.67 a month, billed yearly");
    expect(priv).toHaveTextContent("Most popular");
    expect(screen.getByRole("article", { name: "Connected" })).toHaveTextContent(
      "$65.00 a year$5.42 a month, billed yearly",
    );
    const founding = screen.getByRole("article", { name: "Founding member" });
    expect(founding).toHaveTextContent("$150.00 once · 4 years of Connected");
    // The value right under the price (owner, October 14, 2026).
    expect(founding).toHaveTextContent("42% savings vs the annual Connected plan");
    expect(founding).toHaveTextContent("Save $110 over 4 years · one payment, no renewal");
    expect(founding).toHaveTextContent("147 of 250 places left");
    expect(screen.queryByText("Receipts & invoices")).not.toBeInTheDocument();
    expect(screen.getByText(/how to cancel|you can do here any time/)).toBeInTheDocument();

    await user.click(within(priv).getByRole("button", { name: "Choose Private" }));
    // Before you subscribe: the terms are read and ticked before the payment page.
    const sheet = await screen.findByRole("dialog", { name: "Before you subscribe" });
    expect(sheet).toHaveTextContent("$20.00 today, then every year.");
    expect(sheet).toHaveTextContent("Renews automatically each year until you cancel.");
    const pay = within(sheet).getByRole("button", { name: "Continue to secure payment" });
    expect(pay).toBeDisabled();
    expect(api.calls.some((c) => c.path === "/api/billing/checkout")).toBe(false);
    await user.click(within(sheet).getByRole("checkbox"));
    await user.click(pay);
    await waitFor(() => expect(billingState.lastUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//));
    // The server gets what was read and ticked, to keep as the record of consent.
    expect(api.calls.find((c) => c.path === "/api/billing/checkout")?.body).toEqual({
      plan: "private",
      interval: "yearly",
      consent: {
        version: "2026-10-24",
        lines: [
          "$20.00 today, then every year.",
          "Renews automatically each year until you cancel.",
          "Yearly costs less than 12 monthly payments ($36.00) only if you stay the year.",
          "Cancel any time in Me → Plan. It runs to the end of the paid year; nothing is refunded.",
          "Switch up any time for the difference. Switch down from 30 days in; the rest becomes credit.",
          "Delete your account early: the months used, this one included, cost the monthly price ($3.00); the rest of the year comes back, less Stripe's fee.",
          "A credit or debit card issued by a US bank (Visa, Mastercard, Amex, Discover), or a US bank account. Paid through Stripe; we never see your card or bank details. A bank payment takes up to 4 business days to clear, and the plan starts when it does.",
        ],
        agreement:
          "I understand my plan renews every year until I cancel, cancelling refunds nothing, and deleting my account early charges the months used at the monthly price.",
        // The device's zone: the server wrote the lines' dates on this calendar.
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        accepted: true,
      },
    });
    // The lines came from the server for this offer (October 28, 2026).
    expect(api.calls.find((c) => c.path === "/api/billing/consent/purchase")?.url).toMatch(
      /plan=private&interval=yearly/,
    );

    await user.click(screen.getByRole("radio", { name: "Monthly" }));
    expect(priv).toHaveTextContent("$3.00 a month");
    await user.click(within(priv).getByRole("button", { name: "Choose Private" }));
    await agree(user, "I understand my plan renews every month until I cancel.");
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.path === "/api/billing/checkout").at(-1)?.body,
      ).toMatchObject({
        plan: "private",
        interval: "monthly",
      }),
    );
    await user.click(within(founding).getByRole("button", { name: "Become a Founding member" }));
    await agree(user, "I understand this is one payment for the whole term, and it doesn't renew.");
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.path === "/api/billing/checkout").at(-1)?.body,
      ).toMatchObject({
        plan: "founding",
        interval: null,
      }),
    );
    // Me shows the plan row
  });

  it("once all 250 Founding places are taken, the offer says so and can't be bought", async () => {
    const api = installFakeApi({ session: readySession() });
    api.foundingLeft = 0;
    renderApp("/me/plan");
    const founding = await screen.findByRole("article", { name: "Founding member" });
    expect(founding).toHaveTextContent("0 of 250 places left");
    expect(within(founding).getByRole("button", { name: "All places taken" })).toBeDisabled();
  });

  it("Private yearly: the renewal line, the portal for receipts, cancel and keep in the app", async () => {
    const user = userEvent.setup();
    // refund_cents: what deleting would pay back.
    const api = installFakeApi({
      session: readySession(),
      billing: {
        ...privateBilling(),
        refund_cents: 1966,
        history: [
          {
            kind: "subscribed",
            plan: "connected",
            interval: "monthly",
            amount_cents: 999,
            until: null,
            at: "2025-11-02T14:00:00Z",
          },
          {
            kind: "trial_started",
            plan: "private",
            interval: null,
            amount_cents: null,
            until: null,
            at: "2026-08-20T14:00:00Z",
          },
          {
            kind: "subscribed",
            plan: "private",
            interval: "yearly",
            amount_cents: 2388,
            until: null,
            at: "2026-10-09T15:30:00Z",
          },
        ],
      },
    });
    renderApp("/me/account");
    const row = await screen.findByRole("link", { name: /Private · yearly/ });
    expect(row).toHaveTextContent("Renews Oct 9, 2027 · $20.00");
    await user.click(row);
    expect(await screen.findByRole("heading", { level: 1, name: "Your plan" })).toBeInTheDocument();
    const current = await screen.findByRole("region", { name: "Current plan" });
    expect(current).toHaveTextContent("Private · yearly");
    expect(current).toHaveTextContent("$20.00 a year · renews Oct 9, 2027");
    expect(current).toHaveTextContent(
      "4 jars and goals · unlimited statement accounts · start and join challenges",
    );
    expect(screen.getByText("Switch to monthly")).toBeInTheDocument();
    expect(
      screen.getByText("$3.00 a month · the rest of this year becomes credit"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("article", { name: "Private" })).getByRole("button", {
        name: "Current plan",
      }),
    ).toBeDisabled();

    await user.click(screen.getByText("Receipts & invoices"));
    await waitFor(() => expect(billingState.lastUrl).toMatch(/^https:\/\/billing\.stripe\.com\//));
    expect(api.calls.some((c) => c.method === "POST" && c.path === "/api/billing/portal")).toBe(
      true,
    );
    billingState.lastUrl = null;

    await user.click(screen.getByText("Cancel plan"));
    const sheet = await screen.findByRole("dialog", { name: "If you cancel" });
    expect(sheet).toHaveTextContent("Stays onPrivate runs until Oct 9, 2027.");
    expect(sheet).toHaveTextContent("No chargesNothing more is billed after that.");
    expect(sheet).toHaveTextContent("7-day graceThen subscribe again or download your data.");
    expect(sheet).toHaveTextContent(
      "Then deletedAccount and data go; leftover credit is refunded.",
    );
    expect(sheet).toHaveTextContent(
      /Want money back\?Delete your account instead: \$[\d.,]+ back\./,
    );
    // Nothing cancels until the box is ticked (owner decision, October 18, 2026).
    expect(within(sheet).getByRole("button", { name: "Cancel plan" })).toBeDisabled();
    await user.click(within(sheet).getByRole("button", { name: "Keep Private" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "If you cancel" })).not.toBeInTheDocument(),
    );
    expect(billingState.lastUrl).toBeNull();

    await user.click(screen.getByText("Cancel plan"));
    const again = await screen.findByRole("dialog", { name: "If you cancel" });
    expect(within(again).getByRole("button", { name: "Cancel plan" })).toBeDisabled();
    await user.click(within(again).getByLabelText("I have read and understood these terms."));
    await user.click(within(again).getByRole("button", { name: "Cancel plan" }));
    // Cancelled in the app, no Stripe page: the plan runs to the end of the paid year.
    expect(
      await screen.findByText(
        "Cancelled. Private stays on until Oct 9, 2027. Renew before then to keep your data.",
      ),
    ).toBeInTheDocument();
    expect(billingState.lastUrl).toBeNull();
    const cancelled = api.calls.find(
      (c) => c.method === "POST" && c.path === "/api/billing/cancel",
    );
    expect(cancelled?.body).toMatchObject({
      consent: {
        accepted: true,
        agreement: "I have read and understood these terms.",
        lines: expect.arrayContaining(["Stays on: Private runs until Oct 9, 2027."]),
      },
    });
    expect(await screen.findByRole("region", { name: "Current plan" })).toHaveTextContent(
      "$20.00 a year · ends Oct 9, 2027; renew to keep your data",
    );

    // Plan history, newest first (owner decision, October 18, 2026).
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Plan history" }))
          .getAllByRole("listitem")
          .map((li) => li.querySelector("strong")?.textContent),
      ).toEqual([
        "Cancelled",
        "Subscribed to Private yearly",
        "Free trial started",
        "Subscribed to Connected monthly", // 2025, folded
      ]),
    );
    const history = screen.getByRole("region", { name: "Plan history" });
    // Earlier years fold under their own line; the latest year is open.
    expect(screen.getByText("2026 · 3 changes").closest("details")).toHaveAttribute("open");
    expect(screen.getByText("2025 · 1 change").closest("details")).not.toHaveAttribute("open");
    expect(history).toHaveTextContent("Runs until Oct 9, 2027");
    expect(history).toHaveTextContent("$23.88 a year"); // what was paid then

    await user.click(screen.getByText("Keep my plan"));
    expect(
      await screen.findByText("Kept. Private renews on Oct 9, 2027 as usual."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Plan history" })).getAllByRole("listitem")[0],
      ).toHaveTextContent("KeptPrivate yearly renews as usual"),
    );
    expect(screen.getByText("Cancel plan")).toBeInTheDocument();
  });

  it("Private yearly → Connected: the difference now; down again waits 30 days, then credit", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/me/plan");
    const connected = await screen.findByRole("article", { name: "Connected" });
    await user.click(within(connected).getByRole("button", { name: "Choose Connected" }));
    // A switch on the same subscription: never a second Checkout.
    const sheet = await screen.findByRole("dialog", { name: "Change your plan" });
    expect(sheet).toHaveTextContent("$5.12 today: Connected less what's left of Private.");
    expect(sheet).toHaveTextContent("Switching down again opens in 30 days.");
    expect(sheet).toHaveTextContent("Then $65.00 every year until you cancel.");
    expect(sheet).toHaveTextContent(
      "Delete your account early: the months used, this one included, cost the monthly price ($7.00); the rest of the year comes back, less Stripe's fee.",
    );
    const pay = within(sheet).getByRole("button", { name: "Pay $5.12 and switch" });
    expect(pay).toBeDisabled();
    await user.click(
      within(sheet).getByRole("checkbox", {
        name: "I understand my plan renews every year until I cancel, cancelling refunds nothing, and deleting my account early charges the months used at the monthly price.",
      }),
    );
    await user.click(pay);
    expect(await screen.findByText("Done. You're on Connected · yearly now.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/api/billing/checkout")).toBe(false);
    const sent = api.calls.find((c) => c.path === "/api/billing/change")?.body as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      plan: "connected",
      interval: "yearly",
      proration_date: 1_792_000_000,
    });
    expect(sent.consent).toMatchObject({ accepted: true });
    expect((sent.consent as { lines: string[] }).lines).toContain(
      "Delete your account early: the months used, this one included, cost the monthly price ($7.00); the rest of the year comes back, less Stripe's fee.",
    );

    // Just switched: down is held for 30 days (no hopping); the button says from when and why.
    const privateCard = await screen.findByRole("article", { name: "Private" });
    const later = await within(privateCard).findByRole("button", {
      name: /^Switch to Private from /,
    });
    await user.click(later);
    const why = await screen.findByRole("dialog", { name: /^Switch to Private from / });
    expect(why).toHaveTextContent("You lose nothing by waiting.");
    expect(why).toHaveTextContent("Keep Connected until then; unused time becomes credit.");
    expect(api.calls.filter((c) => c.path === "/api/billing/change/preview")).toHaveLength(1);
    await user.click(within(why).getByRole("button", { name: "Got it" }));
    expect(screen.getByText("Switch to monthly").closest("li")).toHaveTextContent(
      /Available from /,
    );
  });

  it("Connected yearly → Private: at once, the rest becomes credit, banks disconnect", async () => {
    const user = userEvent.setup();
    installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected", disconnects_banks: true },
    });
    renderApp("/me/plan");
    const privateCard = await screen.findByRole("article", { name: "Private" });
    await user.click(within(privateCard).getByRole("button", { name: "Choose Private" }));
    const sheet = await screen.findByRole("dialog", { name: "Change your plan" });
    expect(sheet).toHaveTextContent("Nothing today. $71.99 credit pays your next bills.");
    expect(sheet).toHaveTextContent("Private · yearly starts now.");
    expect(sheet).toHaveTextContent(
      "Private doesn't link banks: yours are disconnected now. Accounts and entries stay.",
    );
    await user.click(
      within(sheet).getByRole("checkbox", {
        name: "I understand my plan renews every year until I cancel, cancelling refunds nothing, and deleting my account early charges the months used at the monthly price.",
      }),
    );
    await user.click(within(sheet).getByRole("button", { name: "Switch now" }));
    expect(
      await screen.findByText(
        "Done. You're on Private · yearly now. $71.99 credit is on your account for your next bills.",
      ),
    ).toBeInTheDocument();
    const current = await screen.findByRole("region", { name: "Current plan" });
    await waitFor(() =>
      expect(current).toHaveTextContent("$71.99 credit on your account, used for your next bills"),
    );
  });

  it("tester tools: only an admin sees them, and switches plans for free", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    const first = renderApp("/me/plan");
    await screen.findByRole("region", { name: "Current plan" });
    expect(screen.queryByRole("region", { name: "Tester tools" })).not.toBeInTheDocument();
    first.unmount();

    const api = installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), tester: true },
    });
    renderApp("/me/plan");
    const tools = await screen.findByRole("region", { name: "Tester tools" });
    await user.click(within(tools).getByRole("button", { name: "Connected" }));
    expect(
      await screen.findByText("Testing as Connected. Nothing is charged."),
    ).toBeInTheDocument();
    expect(api.calls.find((c) => c.path === "/api/billing/tester")?.body).toEqual({
      plan: "connected",
    });
    const current = screen.getByRole("region", { name: "Current plan" });
    await waitFor(() => expect(current).toHaveTextContent("Testing for free: not billed."));
    await user.click(within(tools).getByRole("button", { name: "Back to my real plan" }));
    expect(await screen.findByText("Back to your real plan: Private.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/api/billing/checkout")).toBe(false);
  });

  it("Delete account shows the refund before anything is deleted", async () => {
    installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected", refund_cents: 5500 },
    });
    renderApp("/me/delete");
    const card = await screen.findByRole("region", { name: "Your refund" });
    expect(within(card).getByRole("status")).toHaveTextContent("$55.00");
    expect(card).toHaveTextContent("Back to the card you paid with, not as credit.");
    expect(card).toHaveTextContent(
      "We keep this month (it runs to Nov 9, 2026). On a yearly plan the months used, this one included, cost the monthly price and the rest of the year comes back",
    );
    expect(card).toHaveTextContent("$56.95 unused − $1.95 Stripe card fee = $55.00");
    expect(card).toHaveTextContent(
      "Stripe keeps its card fee (2.9% + 30¢) when a payment is refunded, so it comes off the refund.",
    );
  });

  it("Delete account names the bank and its fee when the plan was paid by bank", async () => {
    installFakeApi({
      session: readySession(),
      billing: { ...privateBilling(), plan: "connected", refund_cents: 5500, paid_by_bank: true },
    });
    renderApp("/me/delete");
    const card = await screen.findByRole("region", { name: "Your refund" });
    expect(card).toHaveTextContent("Back to the bank account you paid with, not as credit.");
    expect(card).toHaveTextContent("Stripe bank fee");
    expect(card).toHaveTextContent(
      "Stripe keeps its bank fee (0.8%, at most $5.00) when a payment is refunded",
    );
    expect(card).not.toHaveTextContent("card fee");
  });

  it("an inbox that may not buy again is told so and how to reach us", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession(), billing: freeBilling(), purchaseBlocked: true });
    renderApp("/me/plan");
    const priv = await screen.findByRole("article", { name: "Private" });
    await user.click(within(priv).getByRole("button", { name: "Choose Private" }));
    const sheet = await screen.findByRole("dialog", { name: "Before you subscribe" });
    await user.click(within(sheet).getByRole("checkbox"));
    await user.click(within(sheet).getByRole("button", { name: "Continue to secure payment" }));
    expect(
      await screen.findByText(/We can't take a new payment on this account\. Write to support@/),
    ).toBeInTheDocument();
    expect(billingState.lastUrl).toBeNull();
  });

  it("subscribed: Founding asks to cancel first rather than charging twice", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/me/plan");
    const founding = await screen.findByRole("article", { name: "Founding member" });
    await user.click(within(founding).getByRole("button", { name: "Become a Founding member" }));
    await agree(user, "I understand this is one payment for the whole term, and it doesn't renew.");
    expect(
      await screen.findByText(/To become a Founding member, cancel your current plan first/),
    ).toBeInTheDocument();
    expect(billingState.lastUrl).toBeNull();
  });

  it("a bank payment still clearing: on its way, and nothing else can be bought meanwhile", async () => {
    installFakeApi({
      session: readySession(),
      billing: { ...freeBilling(), payment_pending: true },
    });
    renderApp("/me/plan");
    expect(await screen.findByText("Your bank payment is on its way")).toBeInTheDocument();
    for (const name of ["Private", "Connected"]) {
      const card = screen.getByRole("article", { name });
      expect(within(card).getByRole("button", { name: `Choose ${name}` })).toBeDisabled();
    }
    const founding = screen.getByRole("article", { name: "Founding member" });
    expect(
      within(founding).getByRole("button", { name: "Become a Founding member" }),
    ).toBeDisabled();
  });

  it("after a plan ends, receipts and invoices are still one tap away", async () => {
    const user = userEvent.setup();
    resetEntitlements();
    const api = installFakeApi({
      session: readySession(),
      billing: { ...freeBilling(), has_customer: true },
    });
    api.access = { state: "lapsed", plan: "free", delete_at: "2026-10-20T00:00:00Z" };
    renderApp("/me/plan");
    const receipts = await screen.findByRole("list", { name: "Receipts" });
    await user.click(within(receipts).getByRole("button", { name: /Receipts & invoices/ }));
    await waitFor(() =>
      expect(billingState.lastUrl).toBe("https://billing.stripe.com/p/session/test"),
    );
  });

  it("Founding member: four years of Connected, no renewal, nothing to buy", async () => {
    installFakeApi({ session: readySession(), billing: foundingBilling() });
    renderApp("/me/plan");
    const current = await screen.findByRole("region", { name: "Current plan" });
    expect(current).toHaveTextContent("Founding member");
    expect(current).toHaveTextContent(
      "$150.00 once · Connected until Oct 10, 2030 · doesn't renew",
    );
    expect(current).toHaveTextContent("10 jars and goals");
    expect(screen.queryByRole("button", { name: /Choose/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Become a Founding member" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Before your term ends/)).toBeInTheDocument();
  });

  it("Free caps jars at 2: a third is refused, and after a downgrade the newest extra is read-only", async () => {
    const user = userEvent.setup();
    const ids = await seedGoals(3); // as if made on Private, then downgraded
    installFakeApi({ session: readySession(), billing: freeBilling() });
    renderApp("/goals");
    await screen.findByRole("navigation", { name: "Primary" });
    const usage = await screen.findByText("Using 3 of 2 on your plan");
    expect(usage.closest(".jar-usage")).toHaveTextContent("See plans");

    await user.click(screen.getByRole("link", { name: "+ New" }));
    await screen.findByRole("heading", { level: 1, name: "New goal" });
    await user.click(screen.getByRole("button", { name: "Create jar" }));
    const limit = await screen.findByRole("status", { name: "Plan limit" });
    expect(limit).toHaveTextContent(
      "Your plan has room for 2 jars and goals, and you have 3. Move a finished one to your templates to free its place.",
    );
    expect(within(limit).getByRole("link", { name: "See plans" })).toHaveAttribute(
      "href",
      "/me/plan",
    );
    expect(await openDb("u1").goals.count()).toBe(3);

    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(await screen.findByRole("link", { name: /Jar 3/ }));
    await screen.findByRole("heading", { level: 1, name: "Jar 3" });
    expect(await screen.findByRole("status", { name: "Plan limit" })).toHaveTextContent(
      "Read-only",
    );
    expect(
      screen.queryByRole("region", { name: "Log money you set aside" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove/ })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(await screen.findByRole("link", { name: /Jar 1/ }));
    await screen.findByRole("heading", { level: 1, name: "Jar 1" });
    expect(screen.getByRole("region", { name: "Log money you set aside" })).toBeInTheDocument();
    expect(ids).toHaveLength(3);
  });

  it("Free: statements for one account, challenges joined one at a time and never started", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    const cash = (await db.accounts.toArray())[0];
    if (!cash) throw new Error("no default account");
    await db.statement_imports.add({
      id: "imp-1",
      account_id: cash.id,
      format: "csv",
      template_key: null,
      file_name: "october.csv",
      period_start: null,
      period_end: null,
      ending_balance_cents: null,
      rows_found: 3,
      rows_added: 3,
      rows_skipped: 0,
      file_key: null,
      status: "done",
      created_at: "2026-10-01T10:00:00Z",
    });
    const mine = { ...mayasGroup(), id: "g-mine", invite_code: "STK-M1NE" };
    mine.members.push(fakeMember(ME, "Nia", 2000));
    const api = installFakeApi({
      session: readySession({
        user: { id: ME, email: "nia@example.com", display_name: "Nia", look: "modern" },
      }),
      billing: freeBilling(),
      groups: [mine, mayasGroup()],
    });

    renderApp("/import");
    await screen.findByRole("heading", { level: 1, name: "Import a statement" });
    const limit = await screen.findByRole("status", { name: "Plan limit" });
    expect(limit).toHaveTextContent(
      "Your plan reads statements for 1 account, and you're using 1.",
    );
    expect(screen.queryByRole("button", { name: "+ New account" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Cash/ })).toBeEnabled();

    await user.click(screen.getByRole("link", { name: "Goals" }));
    await user.click(await screen.findByRole("radio", { name: "Challenges" }));
    expect(await screen.findByText(/starting one needs Private or Connected/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Start a challenge" }));
    await screen.findByRole("heading", { level: 1, name: "Start a challenge" });
    expect(screen.getByRole("button", { name: "Start challenge" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Plan limit" })).toHaveTextContent(
      "needs Private or Connected",
    );

    await user.click(screen.getByRole("link", { name: "Back" }));
    await user.click(await screen.findByRole("radio", { name: "Challenges" }));
    await user.click(await screen.findByRole("link", { name: "Join with a code" }));
    await user.type(await screen.findByLabelText("Invite code"), "4f9q");
    await screen.findByRole("region", { name: "Group" });
    await user.click(screen.getByRole("button", { name: 'Join as "Nia"' }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your plan joins one challenge at a time.",
    );
    expect(api.calls.filter((c) => c.path === "/api/groups/join")).toHaveLength(1);
  });
});
