/**
 * Subscription check (October 28, 2026, docs/spec.md "Subscriptions"): Qash cannot see whether a
 * service is used, so it asks one question at a time and points out facts from the person's own
 * charges (`recurring.subscription_check`). Nothing about it leaves the device.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, type RecurringSeries, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-28T12:00:00");

function series(id: string, label: string, over: Partial<RecurringSeries> = {}): RecurringSeries {
  return {
    id,
    payee: label.toUpperCase(),
    label,
    kind: "bill",
    expected_cents: 1549,
    interval: "monthly",
    next_date: "2026-11-10",
    status: "confirmed",
    source: "detected",
    account_id: null,
    subscription: true,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function charge(id: string, date: string, merchant: string, cents: number): Entry {
  return {
    id,
    date,
    amount_cents: cents,
    direction: "out",
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: "cat-subscriptions",
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: true,
    created_at: `${date}T00:00:00Z`,
    updated_at: `${date}T00:00:00Z`,
  } as Entry;
}

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.recurring_series.bulkAdd([
    series("s-spot", "Spotify", {
      expected_cents: 1299,
      next_date: "2026-11-03",
      checked_at: "2026-09-01",
    }),
    series("s-net", "Netflix", { checked_at: "2026-10-20" }),
    series("s-hulu", "Hulu", { expected_cents: 1800, next_date: "2026-11-15" }),
  ]);
  await db.entries.bulkAdd([
    charge("sp1", "2026-08-03", "Spotify", 1199),
    charge("sp2", "2026-09-03", "Spotify", 1199),
    { ...charge("sp3", "2026-10-03", "Spotify", 1299), is_recurring: false }, // outside the ±10% run
    charge("nf1", "2026-09-10", "Netflix", 1549),
    charge("nf2", "2026-10-10", "Netflix", 1549),
    charge("hu1", "2026-09-15", "Hulu", 1800),
    charge("hu2", "2026-10-15", "Hulu", 1800),
  ]);
  return db;
}

describe("Subscription check", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks one at a time, shows facts from the charges, and Keep it stamps the answer", async () => {
    const user = userEvent.setup();
    const db = await seed();
    const api = installFakeApi({ session: readySession() });
    renderApp("/subscriptions");
    const check = await screen.findByRole("region", { name: "Subscription check" });
    // Hulu was never answered and costs most: 1800 × 12 = $216 a year
    await waitFor(() => expect(check).toHaveTextContent("Still using Hulu? $216.00 a year"));
    expect(check).toHaveTextContent("Check");
    const facts = within(check).getByRole("list", { name: "From your charges" });
    expect(facts).toHaveTextContent("Spotify went from $11.99 to $12.99");
    // (21600 + 18588) ÷ 12 = 3349
    expect(facts).toHaveTextContent("2 video services · $33.49 a month together");
    expect(check).not.toHaveTextContent(/unused/i);

    await user.click(within(check).getByRole("button", { name: "Keep it" }));
    await waitFor(async () =>
      expect((await db.recurring_series.get("s-hulu"))?.checked_at).toBe("2026-10-28"),
    );
    // The price rise asks next; answering Keep after it clears the fact
    await waitFor(() => expect(check).toHaveTextContent("Still using Spotify? $155.88 a year"));
    await user.click(within(check).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(check).toHaveTextContent("Nothing to look at right now."));
    expect(check).not.toHaveTextContent("went from");
    // Two video services are still a fact worth a look
    expect(check).toHaveTextContent("Check");

    // Nothing about the check left the device
    for (const call of api.calls) {
      const body = JSON.stringify(call.body ?? "");
      expect(body).not.toMatch(/Hulu|Spotify|1299|21600|checked_at/);
    }
  });

  it("I cancelled it takes the bill off, and the next question follows", async () => {
    const user = userEvent.setup();
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/subscriptions");
    const check = await screen.findByRole("region", { name: "Subscription check" });
    await waitFor(() => expect(check).toHaveTextContent("Still using Hulu?"));
    await user.click(within(check).getByRole("button", { name: "I cancelled it" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Hulu is off your bills");
    expect(await db.recurring_series.get("s-hulu")).toBeUndefined();
    await waitFor(() => expect(check).toHaveTextContent("Still using Spotify?"));
    expect(check).not.toHaveTextContent("video services");
  });

  it("puts a small card on Home only while there is a question", async () => {
    const db = await seed();
    installFakeApi({ session: readySession() });
    const { unmount } = renderApp("/");
    const link = await screen.findByRole("link", {
      name: /Subscription check: Still using Hulu\?/,
    });
    expect(link).toHaveAttribute("href", "/subscriptions");
    // A title like every other Home card.
    expect(within(link).getByRole("heading", { level: 2, name: "Subscriptions" })).toBeVisible();
    unmount();
    await db.recurring_series.update("s-hulu", { checked_at: "2026-10-28" });
    await db.recurring_series.update("s-spot", { checked_at: "2026-10-28" });
    renderApp("/");
    await screen.findByText("Customize Home");
    await waitFor(() => expect(screen.getAllByRole("link").length).toBeGreaterThan(0));
    expect(screen.queryByRole("link", { name: /Subscription check/ })).toBeNull();
  });

  it("opens with where the money goes by kind, and the check shows the yearly cost as a bar", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/subscriptions");
    const hero = await screen.findByRole("region", { name: "A year of subscriptions" });
    // Video: (1800 + 1549) × 12 = 40188 a year, 3349 a month; Music: 1299 × 12 ÷ 12 = 1299
    const legend = await within(hero).findByRole("list", { name: "By kind" });
    await waitFor(() => expect(legend).toHaveTextContent("Video streaming · 2$33.49 a month"));
    expect(legend).toHaveTextContent("Music$12.99 a month");
    expect(
      within(hero).getByRole("img", {
        name: "Where it goes each month: Video streaming $33.49 a month, Music $12.99 a month",
      }),
    ).toBeVisible();
    const check = screen.getByRole("region", { name: "Subscription check" });
    // Hulu $216 of (40188 + 15588) = $557.76 a year
    expect(
      await within(check).findByRole("img", { name: "Hulu: $216.00 of $557.76 a year" }),
    ).toBeVisible();
  });

  it("Adjust: the person's own intervals reach the rule, and an own value out of range says so", async () => {
    const user = userEvent.setup();
    const db = await seed();
    // Answered 40 days ago: not asked at 90 days, asked at 30
    await db.recurring_series.update("s-hulu", { checked_at: "2026-09-18" });
    await db.recurring_series.update("s-spot", { checked_at: "2026-10-28" });
    await db.recurring_series.update("s-net", { checked_at: "2026-10-28" });
    installFakeApi({ session: readySession() });
    renderApp("/subscriptions");
    const check = await screen.findByRole("region", { name: "Subscription check" });
    await waitFor(() => expect(check).toHaveTextContent("Nothing to look at right now."));
    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const sheet = await screen.findByRole("dialog", { name: "Adjust subscription check" });
    await user.click(
      within(within(sheet).getByRole("group", { name: "Ask again" })).getByRole("radio", {
        name: "30 days",
      }),
    );
    await waitFor(async () =>
      expect((await db.settings.get("subscriptions.ask_days"))?.value).toBe(30),
    );
    await waitFor(() => expect(check).toHaveTextContent("Still using Hulu? $216.00 a year"));

    const own = within(sheet).getByRole("textbox", {
      name: "Your own number of days before a renewal",
    });
    await user.type(own, "120");
    await user.click(within(sheet).getAllByRole("button", { name: "Use" })[1] as HTMLElement);
    expect(within(sheet).getByRole("alert")).toHaveTextContent(
      "Pick a whole number of days from 1 to 90.",
    );
    expect(await db.settings.get("subscriptions.renewal_days")).toBeUndefined();
    await user.clear(own);
    await user.type(own, "45");
    await user.click(within(sheet).getAllByRole("button", { name: "Use" })[1] as HTMLElement);
    await waitFor(async () =>
      expect((await db.settings.get("subscriptions.renewal_days"))?.value).toBe(45),
    );
  });

  it("a renewal shows from the person's own heads-up days", async () => {
    const db = await seed();
    await db.recurring_series.add(
      series("s-cloud", "Cloud", {
        interval: "yearly",
        expected_cents: 9900,
        next_date: "2026-11-20", // 23 days away: past the 15-day default
        checked_at: "2026-10-28",
      }),
    );
    installFakeApi({ session: readySession() });
    const { unmount } = renderApp("/subscriptions");
    const check = await screen.findByRole("region", { name: "Subscription check" });
    await waitFor(() => expect(check).toHaveTextContent("Still using Hulu?"));
    expect(check).not.toHaveTextContent("Cloud renews");
    unmount();
    await db.settings.put({
      key: "subscriptions.renewal_days",
      value: 30,
      updated_at: "2026-10-28T00:00:00Z",
    });
    renderApp("/subscriptions");
    const again = await screen.findByRole("region", { name: "Subscription check" });
    await waitFor(() => expect(again).toHaveTextContent("Cloud renews Nov 20 · $99.00"));
  });

  it("the person sets a kind, which wins over the name; Other takes it out of a group", async () => {
    const user = userEvent.setup();
    const db = await seed();
    installFakeApi({ session: readySession() });
    renderApp("/subscriptions");
    const check = await screen.findByRole("region", { name: "Subscription check" });
    await waitFor(() =>
      expect(check).toHaveTextContent("2 video services · $33.49 a month together"),
    );
    const spotify = screen.getByRole("region", { name: "Spotify" });
    await user.click(within(spotify).getByRole("button", { name: /Change the kind of Spotify/ }));
    const sheet = await screen.findByRole("dialog", { name: "What kind is Spotify?" });
    await user.click(within(sheet).getByRole("radio", { name: "Video streaming" }));
    await waitFor(async () =>
      expect((await db.recurring_series.get("s-spot"))?.subscription_kind).toBe("video"),
    );
    // (21600 + 18588 + 15588) ÷ 12 = 4648
    await waitFor(() =>
      expect(check).toHaveTextContent("3 video services · $46.48 a month together"),
    );
    expect(
      within(spotify).getByRole("button", { name: /Kind: Video streaming/ }),
    ).toHaveTextContent("· yours");

    const hulu = screen.getByRole("region", { name: "Hulu" });
    await user.click(within(hulu).getByRole("button", { name: /Change the kind of Hulu/ }));
    const hsheet = await screen.findByRole("dialog", { name: "What kind is Hulu?" });
    await user.click(within(hsheet).getByRole("radio", { name: "Other" }));
    // (18588 + 15588) ÷ 12 = 2848
    await waitFor(() =>
      expect(check).toHaveTextContent("2 video services · $28.48 a month together"),
    );
    // Back to the name's kind
    await user.click(within(spotify).getByRole("button", { name: /Change the kind of Spotify/ }));
    const back = await screen.findByRole("dialog", { name: "What kind is Spotify?" });
    await user.click(
      within(back).getByRole("button", { name: "Go back to the kind from its name" }),
    );
    await waitFor(async () =>
      expect((await db.recurring_series.get("s-spot"))?.subscription_kind).toBeNull(),
    );
  });

  it("Home's card carries a small picture of where the money goes", async () => {
    await seed();
    installFakeApi({ session: readySession() });
    renderApp("/");
    const link = await screen.findByRole("link", { name: /Subscription check/ });
    expect(
      await within(link).findByRole("img", { name: /Where it goes each month: Video streaming/ }),
    ).toBeInTheDocument();
  });
});
