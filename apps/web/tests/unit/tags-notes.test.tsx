import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dexie from "dexie";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { addTag, MAX_TAGS, suggestTags, tidyTag } from "../../src/features/entries/tags.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

function entry(id: string, merchant: string, cents: number, extra: Partial<Entry> = {}): Entry {
  return {
    id,
    date: "2026-10-05",
    amount_cents: cents,
    direction: "out",
    merchant,
    clean_description: merchant.toUpperCase(),
    raw_description: null,
    category_id: "cat-dining",
    account_id: "acct-cash",
    source: "manual",
    receipt_id: null,
    import_id: null,
    is_transfer: false,
    transfer_pair_id: null,
    split_parent_id: null,
    is_recurring: false,
    created_at: "2026-10-05T00:00:00Z",
    updated_at: "2026-10-05T00:00:00Z",
    ...extra,
  };
}

describe("tags and notes on entries (owner decision, October 19, 2026)", () => {
  it("adds tags (Enter or a comma) and a note, and the list shows them", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(entry("e1", "Luau Grill", 8450));
    installFakeApi({ session: readySession() });
    renderApp("/entries/e1");
    const tags = await screen.findByLabelText("Tags");
    await user.type(tags, "#Hawaii   trip{Enter}");
    await user.type(tags, "work,");
    expect(screen.getByRole("list", { name: "Tags on this entry" })).toHaveTextContent(
      "#Hawaii trip",
    );
    await user.click(screen.getByRole("button", { name: "Remove tag work" }));
    await user.type(screen.getByLabelText("Note"), "Dinner with Sam");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(async () => {
      const saved = await db.entries.get("e1");
      expect(saved?.tags).toEqual(["Hawaii trip"]);
      expect(saved?.note).toBe("Dinner with Sam");
    });
    expect(await screen.findByText(/#Hawaii trip · “Dinner with Sam”/)).toBeInTheDocument();
  });

  it("offers earlier tags while typing, so a trip stays one tag", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("e1", "Luau Grill", 8450, { tags: ["Hawaii trip"] }),
      entry("e2", "Surf rental", 6000),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/entries/e2");
    await user.type(await screen.findByLabelText("Tags"), "ha");
    await user.click(screen.getByRole("button", { name: "+ #Hawaii trip" }));
    expect(screen.getByRole("list", { name: "Tags on this entry" })).toHaveTextContent(
      "#Hawaii trip",
    );
  });

  it("a tag's page totals it across categories and lists its entries", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.bulkAdd([
      entry("e1", "Luau Grill", 8450, { tags: ["Hawaii trip"], date: "2026-10-03" }),
      entry("e2", "Island Air", 41200, {
        tags: ["Hawaii trip"],
        category_id: "cat-transport",
        date: "2026-10-01",
      }),
      entry("e3", "Corner Market", 2000),
    ]);
    installFakeApi({ session: readySession() });
    renderApp("/tags/Hawaii%20trip");
    const total = await screen.findByRole("region", { name: "#Hawaii trip in all" });
    // 84.50 + 412.00
    await waitFor(() => expect(total).toHaveTextContent("$496.50 spent"));
    expect(total).toHaveTextContent("Oct 1 – Oct 3");
    const list = screen.getByRole("list", { name: "Entries tagged Hawaii trip" });
    expect(within(list).getByText("Island Air")).toBeInTheDocument();
    expect(within(list).queryByText("Corner Market")).toBeNull();
  });

  it("the editor takes no input until the entry's own values are in (invariant 18)", async () => {
    // Hold the read back, as a slow phone would: the form must not be there to type into, or
    // the load would overwrite what was typed (the cause of three flaky tests, October 27, 2026).
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(entry("e9", "Corner Market", 900, { note: "Milk", is_transfer: false }));
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = db.transaction("rw", db.entries, async () => {
      await db.entries.get("e9");
      await Dexie.waitFor(gate);
    });
    installFakeApi({ session: readySession() });
    renderApp("/entries/e9");
    expect(await screen.findByText("Opening the entry…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Note")).toBeNull();
    expect(screen.queryByRole("switch", { name: /Transfer between my accounts/ })).toBeNull();
    release();
    await held;
    const note = await screen.findByLabelText("Note");
    expect(note).toHaveValue("Milk");
    await user.type(note, " and eggs");
    expect(note).toHaveValue("Milk and eggs");
  });

  it("an entry that is gone says so instead of an empty form", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    installFakeApi({ session: readySession() });
    renderApp("/entries/nope");
    expect(
      await screen.findByText("This entry isn't on this device any more."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Note")).toBeNull();
  });

  it("saving an edit keeps what the screen doesn't show, like a linked row's bank id", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await seedDefaults(db);
    await db.entries.add(
      entry("lnk-1", "Linked Cafe", 900, { source: "linked", provider_txn_id: "txn-9" }),
    );
    installFakeApi({ session: readySession() });
    renderApp("/entries/lnk-1");
    await user.type(await screen.findByLabelText("Note"), "Coffee");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(async () => {
      const saved = await db.entries.get("lnk-1");
      expect(saved?.note).toBe("Coffee");
      expect(saved?.provider_txn_id).toBe("txn-9");
    });
  });
});

describe("tag rules", () => {
  it("tidies, keeps one per spelling in any case, and stops at the limit", () => {
    expect(tidyTag("  ##Road   trip ")).toBe("Road trip");
    expect(addTag(["Road trip"], "road TRIP")).toEqual(["Road trip"]);
    expect(addTag([], "   ")).toEqual([]);
    const full = ["a", "b", "c", "d", "e"];
    expect(full).toHaveLength(MAX_TAGS);
    expect(addTag(full, "f")).toBe(full);
    expect(suggestTags(["Hawaii trip", "Home", "Work"], "h", ["Home"])).toEqual(["Hawaii trip"]);
  });
});
