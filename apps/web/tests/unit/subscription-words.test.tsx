/**
 * The person's own subscription kinds and words (owner decision, October 29, 2026; docs/spec.md
 * "Subscriptions"): Qash's list stays fixed; their words are tried first, a kind set by hand wins
 * over both, and nothing of it leaves the device except as ciphertext in a backup.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSnapshot, SYNCED_TABLES } from "../../src/data/backup/snapshot.ts";
import { openDb, type RecurringSeries, seedDefaults } from "../../src/data/db.ts";
import { collectExport } from "../../src/data/export.ts";
import {
  addOwnWord,
  checkKindName,
  checkWord,
  createOwnKind,
  MAX_OWN_KINDS,
  suggestWord,
} from "../../src/features/subscriptions/ownKinds.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-29T12:00:00");

function series(id: string, label: string, over: Partial<RecurringSeries> = {}): RecurringSeries {
  return {
    id,
    payee: label.toUpperCase(),
    label,
    kind: "bill",
    expected_cents: 1000,
    interval: "monthly",
    next_date: "2026-11-10",
    status: "confirmed",
    source: "detected",
    account_id: null,
    subscription: true,
    checked_at: "2026-10-29",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

async function seed() {
  const db = openDb("u1");
  await seedDefaults(db);
  await db.recurring_series.bulkAdd([
    series("s-club", "Kids Club", { payee: "KIDS CLUB", expected_cents: 1200 }),
    series("s-lego", "Lego Box", { payee: "LEGO BOX MONTHLY", expected_cents: 1500 }),
    series("s-net", "Netflix", { payee: "NETFLIX.COM", expected_cents: 1549 }),
  ]);
  return db;
}

describe("own kinds and words: the checks", () => {
  it("a kind's name is 1–24 characters, unique ignoring case against Qash's and their own", () => {
    expect(checkKindName("  Kids  ", [])).toEqual({ name: "Kids" });
    expect(checkKindName("   ", [])).toEqual({ problem: "Give the kind a name." });
    expect(checkKindName("x".repeat(25), [])).toEqual({ problem: "Keep it to 24 characters." });
    expect(checkKindName("music", [])).toMatchObject({ problem: /Qash already has/ });
    expect(checkKindName("OTHER", [])).toMatchObject({ problem: /Qash already has/ });
    const mine = [{ id: "own-1", label: "Kids", created_at: "", updated_at: "" }];
    expect(checkKindName("kids", mine)).toEqual({
      problem: "You already have a kind with that name.",
    });
    expect(checkKindName("kids", mine, "own-1")).toEqual({ name: "kids" });
  });

  it("a word is upper-cased like the table, 2–40 characters, letters, digits and ' * + .", () => {
    expect(checkWord(" disney+  plus ", [])).toEqual({ match: "DISNEY+ PLUS" });
    expect(checkWord("a", [])).toMatchObject({ problem: /2 to 40/ });
    expect(checkWord("x".repeat(41), [])).toMatchObject({ problem: /2 to 40/ });
    expect(checkWord("café", [])).toMatchObject({ problem: /letters, numbers/ });
    expect(checkWord("a-b", [])).toMatchObject({ problem: /letters, numbers/ });
    expect(checkWord("..", [])).toMatchObject({ problem: /letter or number/ });
    const mine = [{ id: "w1", match: "NETFLIX", kind: "video", created_at: "", updated_at: "" }];
    expect(checkWord("netflix", mine)).toEqual({ problem: "You already have that word." });
    expect(checkWord("netflix", mine, "w1")).toEqual({ match: "NETFLIX" });
  });

  it("suggests the payee's first real word, without a web ending or a payment prefix", () => {
    expect(suggestWord("NETFLIX.COM")).toBe("NETFLIX");
    expect(suggestWord("SQ *BLUE BOTTLE")).toBe("BLUE");
    expect(suggestWord("LEGO BOX MONTHLY")).toBe("LEGO");
    expect(suggestWord("GYM 24")).toBe("GYM");
    expect(suggestWord("AB 12")).toBe("AB 12");
  });
});

describe("own kinds and words on Subscriptions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("their word is tried before Qash's and their kind shows in the picture", async () => {
    const db = await seed();
    const family = await createOwnKind(db, "Family");
    await addOwnWord(db, "netflix", family.id);
    await addOwnWord(db, "kids", family.id);
    installFakeApi({ session: readySession() });
    renderApp("/subscriptions");
    const legend = await screen.findByRole("list", { name: "By kind" });
    // Netflix (their word beats the table's video) and Kids Club: 1549 + 1200 a month together
    await waitFor(() => expect(legend).toHaveTextContent("Family · 2$27.49 a month"));
    const check = screen.getByRole("region", { name: "Subscription check" });
    expect(check).toHaveTextContent("2 subscriptions in Family · $27.49 a month together");
    expect(
      within(screen.getByRole("region", { name: "Netflix" })).getByRole("button", {
        name: /Kind: Family/,
      }),
    ).toBeInTheDocument();
  });

  it("+ New kind and “Also for future charges” save a kind, a word and the pick, and nothing is sent", async () => {
    const user = userEvent.setup();
    const db = await seed();
    const api = installFakeApi({ session: readySession() });
    renderApp("/subscriptions");
    await user.click(await screen.findByRole("button", { name: /Change the kind of Lego Box/ }));
    const sheet = await screen.findByRole("dialog", { name: "What kind is Lego Box?" });
    await user.click(within(sheet).getByRole("switch", { name: /Also for future charges/ }));
    const word = within(sheet).getByRole("textbox", { name: "When a charge says" });
    expect(word).toHaveValue("LEGO");
    await user.click(within(sheet).getByRole("button", { name: "+ New kind" }));
    const made = await screen.findByRole("dialog", { name: "New kind" });
    await user.type(within(made).getByRole("textbox", { name: "Name of the kind" }), "Toys");
    await user.click(within(made).getByRole("button", { name: "Add and use it" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Lego Box is now Toys. Charges that say LEGO will be too.",
      ),
    );
    const kinds = await db.own_subscription_kinds.toArray();
    expect(kinds.map((k) => k.label)).toEqual(["Toys"]);
    expect(kinds[0]?.id).toMatch(/^own-/);
    expect((await db.own_subscription_words.toArray()).map((w) => [w.match, w.kind])).toEqual([
      ["LEGO", kinds[0]?.id],
    ]);
    expect((await db.recurring_series.get("s-lego"))?.subscription_kind).toBe(kinds[0]?.id);

    // A word the table never had: invalid characters are refused in plain words
    await user.click(screen.getByRole("button", { name: /Change the kind of Kids Club/ }));
    const again = await screen.findByRole("dialog", { name: "What kind is Kids Club?" });
    await user.click(within(again).getByRole("switch", { name: /Also for future charges/ }));
    const box = within(again).getByRole("textbox", { name: "When a charge says" });
    await user.clear(box);
    await user.type(box, "kids-club");
    await user.click(within(again).getByText("Toys", { exact: true }));
    expect(within(again).getByRole("alert")).toHaveTextContent("Use letters, numbers");
    expect((await db.recurring_series.get("s-club"))?.subscription_kind).toBeUndefined();

    for (const call of api.calls) {
      const body = JSON.stringify(call.body ?? "");
      expect(body).not.toMatch(/Toys|LEGO|own-/);
    }
  });

  it("Me → Subscription words lists, edits and removes; removing a kind sends its subscriptions back", async () => {
    const user = userEvent.setup();
    const db = await seed();
    const toys = await createOwnKind(db, "Toys");
    await addOwnWord(db, "LEGO", toys.id);
    await db.recurring_series.update("s-club", { subscription_kind: toys.id });
    installFakeApi({ session: readySession() });
    renderApp("/me/subscription-words");
    const words = await screen.findByRole("list", { name: "Your words" });
    expect(words).toHaveTextContent("LEGO");
    expect(words).toHaveTextContent("It's Toys");
    expect(screen.getByRole("list", { name: "Your kinds" })).toHaveTextContent(
      "Toys1 subscription · 1 word",
    );

    // Add one through the top-right action
    await user.click(screen.getByRole("button", { name: "Add word" }));
    const add = await screen.findByRole("dialog", { name: "Add a word" });
    await user.type(within(add).getByRole("textbox", { name: "When a charge says" }), "hbo max");
    await user.click(within(add).getByText("Video streaming", { exact: true }));
    await user.click(within(add).getByRole("button", { name: "Add word" }));
    await waitFor(() => expect(words).toHaveTextContent("HBO MAX"));

    // Remove the kind: its subscription goes back to its name, its word goes, tombstones stay
    await user.click(within(screen.getByRole("list", { name: "Your kinds" })).getByText("Toys"));
    const edit = await screen.findByRole("dialog", { name: "Edit Toys" });
    await user.click(within(edit).getByRole("button", { name: "Remove Toys" }));
    expect(edit).toHaveTextContent("1 subscription goes back to the kind from its name.");
    await user.click(within(edit).getByRole("button", { name: "Remove Toys" }));
    await waitFor(async () => expect(await db.own_subscription_kinds.count()).toBe(0));
    expect((await db.recurring_series.get("s-club"))?.subscription_kind).toBeNull();
    expect((await db.own_subscription_words.toArray()).map((w) => w.match)).toEqual(["HBO MAX"]);
    const tombs = await db.tombstones.toArray();
    expect(tombs.map((t) => t.table).sort()).toEqual([
      "own_subscription_kinds",
      "own_subscription_words",
    ]);
  });

  it("caps own kinds at the proposed 20", async () => {
    const db = await seed();
    for (let i = 0; i < MAX_OWN_KINDS; i += 1) await createOwnKind(db, `Kind ${i}`);
    await expect(createOwnKind(db, "One more")).rejects.toThrow(/20 kinds of your own/);
  });

  it("travel in the encrypted backup and in the export", async () => {
    const db = await seed();
    const toys = await createOwnKind(db, "Toys");
    await addOwnWord(db, "LEGO", toys.id);
    const names = SYNCED_TABLES.map((t) => t.name);
    expect(names).toContain("own_subscription_kinds");
    expect(names).toContain("own_subscription_words");
    const snap = await buildSnapshot(db, { rulesVersion: "0.39.0", deviceId: "dev-1" });
    expect(snap.tables.own_subscription_kinds).toHaveLength(1);
    expect(snap.tables.own_subscription_words).toHaveLength(1);
    const files = await collectExport(db, null, "2026-10-29T12:00:00Z");
    const settings = files.find((f) => f.name === "settings.json");
    const text = new TextDecoder().decode(settings?.data as Uint8Array);
    expect(text).toContain('"own_subscription_kinds"');
    expect(text).toContain('"LEGO"');
  });
});
