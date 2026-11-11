// Split bills, the organizer's screens (chunk S.3b): a group from Goals → Splits, invites, a
// bill through the engine, a guest's bill waiting for the OK, Mark paid, Remove, the day's limit
// and double-check. Nothing readable about a bill or a group's name leaves the device (78).

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { openDb } from "../../src/data/db.ts";
import { emptyLedger, type LedgerBlob, type SplitBill } from "../../src/features/splits/ledger.ts";
import { groupKey, openLedger, sealLedger } from "../../src/features/splits/splitSync.ts";
import { createSplitGroup } from "../../src/features/splits/useSplits.ts";
import { todayIso } from "../../src/lib/format.ts";
import { type FakeApi, installFakeApi, readySession } from "../fakeApi.ts";
import { readableIn } from "../leaks.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-11-08T12:00:00");
const ME = "m-u1";
const SAM = "m-u-sam";
const ALEX = "m-u-alex";

function noSecretsLeft(api: FakeApi, words: string[]) {
  for (const call of api.calls) {
    const text = `${decodeURIComponent(call.url)} ${call.raw}`;
    for (const w of words)
      expect(readableIn(text, w), `${w} in ${call.method} ${call.path}`).toBe(false);
  }
}

async function seedGroup(api: FakeApi): Promise<string> {
  const r = await createSplitGroup(openDb("u1"), {
    name: "Apartment 4B",
    kind: "home",
    usual_method: "equal",
    leftover: "payer",
  });
  if (!r.ok) throw new Error(r.code);
  const g = api.splits.groups[0];
  if (!g) throw new Error("no group");
  const at = new Date().toISOString();
  g.members.push(
    { member_id: SAM, user_id: "u-sam", display_name: "Sam", guest: true, joined_at: at },
    { member_id: ALEX, user_id: "u-alex", display_name: "Alex", guest: true, joined_at: at },
  );
  return g.id;
}

async function writeLedger(api: FakeApi, gid: string, member: string, ledger: LedgerBlob) {
  const key = await groupKey(openDb("u1"), gid);
  if (!key) throw new Error("no key");
  const g = api.splits.groups.find((x) => x.id === gid);
  if (!g) throw new Error("no group");
  const rows = await sealLedger(key, gid, member, ledger, todayIso().slice(0, 7));
  for (const r of rows) {
    const old = g.blobs.find((b) => b.member_id === member && b.kind === r.kind);
    g.blobs = [
      ...g.blobs.filter((b) => b !== old),
      {
        member_id: member,
        kind: r.kind,
        ciphertext: r.ciphertext,
        version: (old?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
      },
    ];
  }
}

async function readLedger(api: FakeApi, gid: string, member: string): Promise<LedgerBlob> {
  const key = await groupKey(openDb("u1"), gid);
  if (!key) throw new Error("no key");
  const g = api.splits.groups.find((x) => x.id === gid);
  return (await openLedger(key, gid, member, g?.blobs ?? [])) ?? emptyLedger();
}

function bill(id: string, by: string, amount: number, parts: number[], what: string): SplitBill {
  return {
    id,
    date: "2026-11-07",
    what,
    amount_cents: amount,
    paid_by: by,
    people: [ME, SAM, ALEX],
    method: "equal",
    values: null,
    leftover_to: by,
    parts: [ME, SAM, ALEX].map((person, i) => ({ person, cents: parts[i] ?? 0 })),
    repeat: null,
    repeat_until: null,
    added_by: by,
    updated_at: "2026-11-07T10:00:00Z",
  };
}

/** Groceries $186 paid by me, split three ways, already in my ledger and approved. */
async function seedGroceries(api: FakeApi, gid: string) {
  const g = api.splits.groups[0];
  g?.bills.push({ id: "b-groc", created_by: "u1", status: "approved" });
  const key = await groupKey(openDb("u1"), gid);
  if (!key) throw new Error("no key");
  // My ledger already holds the group's name; add the bill to it.
  const current = await readLedger(api, gid, ME);
  await writeLedger(api, gid, ME, {
    ...current,
    bills: [...current.bills, bill("b-groc", ME, 18600, [6200, 6200, 6200], "Groceries")],
  });
}

describe("Split bills: the organizer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a group from Goals → Splits and invites by email; the name never leaves readable", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/splits");
    await user.click(await screen.findByRole("link", { name: "+ New group" }));
    await user.type(await screen.findByLabelText("Group name"), "Apartment 4B");
    await user.type(screen.getByLabelText("Your name, as the group sees it"), "Nia");
    await user.click(screen.getByRole("button", { name: "Create and invite" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Apartment 4B" }),
    ).toBeInTheDocument();
    const sheet = await screen.findByRole("dialog", { name: "Invite by email" });
    await user.type(within(sheet).getByLabelText("Their email"), "sam@example.com");
    await user.click(within(sheet).getByRole("button", { name: "Send invite" }));
    expect(await within(sheet).findByText(/Invite sent to sam@example.com/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "In person? Show a QR code" }));
    expect(
      await within(sheet).findByRole("img", { name: "QR code to join this group" }),
    ).toBeInTheDocument();

    expect(api.splits.groups[0]?.invites).toHaveLength(1);
    noSecretsLeft(api, ["Apartment 4B", "Apartment", "4B"]);
  });

  it("adds a bill split equally through the engine; balances simplify to who pays whom", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.type(await screen.findByLabelText("1 · How much?"), "186");
    await user.type(screen.getByLabelText("What's it for?"), "Groceries");
    expect(await screen.findByText("Only $62.00 counts as yours.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add bill" }));

    expect(await screen.findByText("Sam pays you $62.00")).toBeInTheDocument();
    expect(screen.getByText("Alex pays you $62.00")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your balance" })).toHaveTextContent(
      /Owed\$124\.00 owed to you/,
    );
    expect(api.splits.added_today).toBe(1);
    noSecretsLeft(api, ["Groceries", "18600", "6200", "Apartment"]);
  });

  it("Exact starts even, follows the amount until someone types, then shows what's left", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.click(await screen.findByRole("radio", { name: "Exact" }));
    expect(
      screen.getByText("Type each person's dollars. They add up to the total."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("You, $")).toHaveValue("");
    await user.type(screen.getByLabelText("1 · How much?"), "90");
    await waitFor(() => expect(screen.getByLabelText("Sam, $")).toHaveValue("30.00"));
    expect(await screen.findByText("Adds up to $90.00 of $90.00")).toHaveClass("split-total--ok");
    // The unit is on screen beside each box.
    expect(screen.getAllByText("$", { selector: ".split-value__unit" })).toHaveLength(3);
    await user.clear(screen.getByLabelText("You, $"));
    await user.type(screen.getByLabelText("You, $"), "20");
    expect(await screen.findByText("Adds up to $80.00 of $90.00 · $10.00 left")).toHaveClass(
      "split-total--off",
    );
    // Typed values stay put when the amount changes.
    await user.type(screen.getByLabelText("1 · How much?"), "0");
    expect(
      await screen.findByText("Adds up to $80.00 of $900.00 · $820.00 left"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Sam, $")).toHaveValue("30.00");
  });

  it("splits by shares with the leftover cent to the person the organizer picks", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.type(await screen.findByLabelText("1 · How much?"), "100");
    await user.click(screen.getByRole("radio", { name: "Shares" }));
    // The choice says what it means, and the boxes start at 1 share each (owner, November 11, 2026).
    expect(
      screen.getByText("Type a whole number each. 2 pays twice what 1 does."),
    ).toBeInTheDocument();
    for (const who of ["You", "Sam", "Alex"])
      expect(screen.getByLabelText(`${who}, shares`)).toHaveValue("1");
    expect(await screen.findByText("3 shares in all")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("A leftover cent goes to"), "Sam");
    // $100 ÷ 3 = $33.33 each, the leftover cent to Sam
    expect(await screen.findByText("Only $33.33 counts as yours.")).toBeInTheDocument();
    expect(screen.getByText("= $33.34")).toBeInTheDocument();
  });

  it("a guest's bill waits for the organizer's OK and counts once approved", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.groups[0]?.bills.push({ id: "b-clean", created_by: "u-sam", status: "pending" });
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-clean", SAM, 2400, [800, 800, 800], "Cleaning")],
    });
    renderApp(`/splits/${gid}`);
    const waiting = await screen.findByRole("region", { name: "Waiting for your OK" });
    expect(within(waiting).getByText("Cleaning · $24.00 · added by Sam")).toBeInTheDocument();
    // Pending moves nobody
    expect(screen.queryByText(/pays/)).not.toBeInTheDocument();
    await user.click(within(waiting).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("You pay Sam $8.00")).toBeInTheDocument();
    expect(screen.getByText("Alex pays Sam $8.00")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Waiting for your OK" })).not.toBeInTheDocument();
    expect(api.splits.added_today).toBe(1);
  });

  it("Mark paid by the person paid settles it for everyone; part payments leave the rest", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    await seedGroceries(api, gid);
    renderApp(`/splits/${gid}`);
    const row = (await screen.findByText("Sam pays you $62.00")).closest(
      ".split-pay",
    ) as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Mark paid" }));
    const sheet = await screen.findByRole("dialog", { name: "Mark paid" });
    const amount = within(sheet).getByLabelText("How much was paid?");
    await user.clear(amount);
    await user.type(amount, "50");
    await user.click(within(sheet).getByRole("button", { name: "Mark paid" }));
    expect(await screen.findByText("Sam pays you $12.00")).toBeInTheDocument();
    // S.10: Sam hears his payment counts, in fixed words.
    await waitFor(() =>
      expect(api.splits.notified).toEqual([{ kind: "confirmed", member_id: SAM }]),
    );
    noSecretsLeft(api, ["5000", "Groceries"]);
  });

  it("paying Sam back is my spending once, in the category of my shared bill (S.6)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.groups[0]?.bills.push({ id: "b-sam", created_by: "u-sam", status: "approved" });
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-sam", SAM, 9000, [3000, 3000, 3000], "Utilities")],
    });
    const db = openDb("u1");
    const at = new Date().toISOString();
    await db.entries.add({
      id: "e-shared",
      date: "2026-11-05",
      amount_cents: 6200,
      direction: "out",
      merchant: "CITY POWER",
      clean_description: "CITY POWER",
      raw_description: null,
      category_id: "cat-groceries",
      account_id: "acct-cash",
      source: "manual",
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      split_bill: `${gid}:b-x`,
      created_at: at,
      updated_at: at,
    });
    renderApp(`/splits/${gid}`);
    const row = (await screen.findByText("You pay Sam $30.00")).closest(
      ".split-pay",
    ) as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Mark paid" }));
    const sheet = await screen.findByRole("dialog", { name: "Mark paid" });
    const add = within(sheet).getByRole("switch", { name: "Add it to my spending" });
    await waitFor(() => expect(add).toBeChecked());
    expect(within(sheet).getByRole("radio", { name: "Groceries" })).toBeChecked();
    await user.click(within(sheet).getByRole("button", { name: "Mark paid" }));
    await waitFor(async () =>
      expect((await db.entries.toArray()).filter((e) => e.split_settle)).toHaveLength(1),
    );
    const paid = (await db.entries.toArray()).find((e) => e.split_settle);
    expect(paid).toMatchObject({
      merchant: "Paid Sam",
      amount_cents: 3000,
      direction: "out",
      category_id: "cat-groceries",
    });
    expect(paid?.split_settle).toMatch(new RegExp(`^${gid}:`));
  });

  it("with statements on this device, paying back adds nothing unless asked: the bank shows it (S.6)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.groups[0]?.bills.push({ id: "b-sam", created_by: "u-sam", status: "approved" });
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-sam", SAM, 9000, [3000, 3000, 3000], "Utilities")],
    });
    const db = openDb("u1");
    await db.statement_imports.add({
      id: "imp-1",
      account_id: "acct-cash",
      format: "csv",
      template_key: null,
      file_name: "october.csv",
      period_start: null,
      period_end: null,
      ending_balance_cents: null,
      rows_found: 1,
      rows_added: 1,
      rows_skipped: 0,
      file_key: null,
      status: "done",
      created_at: "2026-10-01T10:00:00Z",
    });
    renderApp(`/splits/${gid}`);
    const row = (await screen.findByText("You pay Sam $30.00")).closest(
      ".split-pay",
    ) as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Mark paid" }));
    const sheet = await screen.findByRole("dialog", { name: "Mark paid" });
    const add = within(sheet).getByRole("switch", { name: "Add it to my spending" });
    await waitFor(() => expect(add).not.toBeChecked());
    await user.click(within(sheet).getByRole("button", { name: "Mark paid" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mark paid" })).toBeNull());
    expect((await db.entries.toArray()).filter((e) => e.split_settle)).toHaveLength(0);
  });

  it("an organizer who left keeps every deletion; Run this group carries them over (S.6)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    const JORDAN = "m-u-jordan";
    const g = api.splits.groups[0];
    if (!g) throw new Error("no group");
    // Jordan ran it, deleted Sam's b-dup, then left; I'm a member with a plan.
    await writeLedger(api, gid, JORDAN, {
      ...emptyLedger(),
      edits: { "b-dup": null },
      group: {
        name: "Lake house",
        kind: "trip",
        usual_method: "equal",
        leftover: "payer",
        updated_at: "2026-11-01T00:00:00Z",
      },
    });
    await writeLedger(api, gid, ME, emptyLedger());
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [
        bill("b-dup", SAM, 9000, [3000, 3000, 3000], "Twice"),
        bill("b-ok", SAM, 3000, [1000, 1000, 1000], "Firewood"),
      ],
    });
    g.bills.push(
      { id: "b-dup", created_by: "u-sam", status: "approved" },
      { id: "b-ok", created_by: "u-sam", status: "approved" },
    );
    g.organizer_user = null;
    g.writable = false;
    g.previous_organizer_member_id = JORDAN;
    renderApp(`/splits/${gid}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Lake house" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/nobody runs this group now/)).toBeInTheDocument();
    expect(screen.queryByText(/Twice/)).toBeNull();
    expect(screen.getByText(/Firewood/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Run this group" }));
    expect(await screen.findByText("You run this group now.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Lake house" })).toBeInTheDocument();
    expect(screen.queryByText(/Twice/)).toBeNull();
    const mine = await readLedger(api, gid, ME);
    expect(mine.edits).toMatchObject({ "b-dup": null });
    expect(mine.group?.name).toBe("Lake house");
    expect(screen.getByRole("button", { name: "Name, usual split and more" })).toBeInTheDocument();
  });

  it("the organizer changes the name and sets the usual split by shares (S.6)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}`);
    await user.click(await screen.findByRole("button", { name: "Name, usual split and more" }));
    const sheet = await screen.findByRole("dialog", { name: "Group settings" });
    const name = within(sheet).getByLabelText("Group name");
    await user.clear(name);
    await user.type(name, "Apartment 5C");
    await user.click(within(sheet).getByRole("radio", { name: "Shares" }));
    expect(await within(sheet).findByText("3 shares in all")).toBeInTheDocument();
    await user.clear(within(sheet).getByLabelText("You, shares"));
    await user.type(within(sheet).getByLabelText("You, shares"), "2");
    await user.clear(within(sheet).getByLabelText("Alex, shares"));
    expect(
      await within(sheet).findByText("3 shares in all · fill in everyone"),
    ).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(/whole number/);
    await user.type(within(sheet).getByLabelText("Alex, shares"), "1");
    expect(await within(sheet).findByText("4 shares in all")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Apartment 5C" }),
    ).toBeInTheDocument();
    const mine = await readLedger(api, gid, ME);
    expect(mine.group).toMatchObject({
      name: "Apartment 5C",
      usual_method: "shares",
      usual_values: { [ME]: 2, [SAM]: 1, [ALEX]: 1 },
    });
    noSecretsLeft(api, ["Apartment 5C"]);
  });

  it("Add bill is never a dead button: tapping it says what's missing and goes there", async () => {
    // Owner, November 11, 2026: every field filled, Percent chosen, and Add bill stayed grey with
    // only a small hint saying why.
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    const add = await screen.findByRole("button", { name: "Add bill" });
    expect(add).toBeEnabled();
    await user.click(add);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter how much.");
    expect(screen.getByLabelText("1 · How much?")).toHaveFocus();

    await user.type(screen.getByLabelText("1 · How much?"), "90");
    await user.click(screen.getByRole("radio", { name: "Percent" }));
    // An even start: 33.34 / 33.33 / 33.33 adds up, so nothing is missing yet.
    expect(await screen.findByText("Adds up to 100% of 100%")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("You, %"));
    expect(await screen.findByText("Adds up to 66.66% of 100% · 33.34% left")).toHaveClass(
      "split-total--off",
    );
    await user.click(add);
    expect(screen.getByRole("alert")).toHaveTextContent("Fill in everyone who's in.");
    expect(screen.getByLabelText("You, %")).toHaveFocus();

    await user.type(screen.getByLabelText("You, %"), "50");
    for (const who of ["Sam", "Alex"]) {
      await user.clear(screen.getByLabelText(`${who}, %`));
      await user.type(screen.getByLabelText(`${who}, %`), "25");
    }
    expect(await screen.findByText("Adds up to 100% of 100%")).toHaveClass("split-total--ok");
    await user.click(add);
    expect(screen.getByRole("alert")).toHaveTextContent("Say what it's for.");
    expect(screen.getByLabelText("What's it for?")).toHaveFocus();

    await user.type(screen.getByLabelText("What's it for?"), "Rent");
    await user.click(add);
    await screen.findByRole("heading", { level: 1, name: "Apartment 4B" });
    expect(api.splits.groups[0]?.bills ?? []).not.toHaveLength(0);
  });

  it("what a group is for: suggestions or the person's own words, kept encrypted (November 11, 2026)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/splits/new");
    expect(await screen.findByText("What's it for?")).toBeInTheDocument();
    for (const label of ["Home & rent", "Trip", "Restaurant"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("radio", { name: "Friends" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Family" })).toBeNull();
    await user.type(screen.getByLabelText("Group name"), "Book club");
    await user.type(screen.getByLabelText("Your name, as the group sees it"), "Nia");
    const own = screen.getByLabelText("Or name your own");
    await user.type(own, "x".repeat(25));
    await user.click(screen.getByRole("button", { name: "Use" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Keep it to 24 characters.");
    await user.clear(own);
    await user.type(own, "  Book   club snacks ");
    await user.click(screen.getByRole("button", { name: "Use" }));
    await user.click(screen.getByRole("button", { name: "Create and invite" }));
    await screen.findByRole("dialog", { name: "Invite by email" });
    const gid = api.splits.groups[0]?.id as string;
    expect(
      (await readLedger(api, gid, api.splits.groups[0]?.members[0]?.member_id as string)).group
        ?.kind,
    ).toBe("own:Book club snacks");
    noSecretsLeft(api, ["Book club snacks"]);
  });

  it("an own kind shows again in Group settings; typing a suggestion's name picks it", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}`);
    await user.click(await screen.findByRole("button", { name: "Name, usual split and more" }));
    let sheet = await screen.findByRole("dialog", { name: "Group settings" });
    const own = within(sheet).getByLabelText("Or name your own");
    await user.type(own, "Ski weekend");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(async () =>
      expect((await readLedger(api, gid, ME)).group?.kind).toBe("own:Ski weekend"),
    );
    await user.click(await screen.findByRole("button", { name: "Name, usual split and more" }));
    sheet = await screen.findByRole("dialog", { name: "Group settings" });
    expect(within(sheet).getByLabelText("Or name your own")).toHaveValue("Ski weekend");
    await user.clear(within(sheet).getByLabelText("Or name your own"));
    await user.type(within(sheet).getByLabelText("Or name your own"), "trip");
    await user.click(within(sheet).getByRole("button", { name: "Use" }));
    expect(within(sheet).getByRole("radio", { name: "Trip" })).toBeChecked();
    expect(within(sheet).getByLabelText("Or name your own")).toHaveValue("");
  });

  it("a bill's history: added, approved and what the organizer changed (S.6)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.groups[0]?.bills.push({ id: "b-clean", created_by: "u-sam", status: "pending" });
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-clean", SAM, 2400, [800, 800, 800], "Cleaning")],
    });
    renderApp(`/splits/${gid}`);
    const waiting = await screen.findByRole("region", { name: "Waiting for your OK" });
    await user.click(within(waiting).getByRole("button", { name: "Approve" }));
    await screen.findByText("You pay Sam $8.00");
    await user.click(screen.getByText(/Cleaning/));
    const sheet = await screen.findByRole("dialog", { name: "Cleaning" });
    const history = within(sheet).getByRole("region", { name: "History" });
    expect(history).toHaveTextContent("Added by Sam");
    expect(history).toHaveTextContent("Approved by You");
  });

  it("a payment's note shows in History, and Undo takes it back with its spending entry (S.7)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.groups[0]?.bills.push({ id: "b-sam", created_by: "u-sam", status: "approved" });
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-sam", SAM, 9000, [3000, 3000, 3000], "Utilities")],
    });
    renderApp(`/splits/${gid}`);
    const row = (await screen.findByText("You pay Sam $30.00")).closest(
      ".split-pay",
    ) as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Mark paid" }));
    const sheet = await screen.findByRole("dialog", { name: "Mark paid" });
    await user.type(within(sheet).getByLabelText("Note (optional)"), "cash at dinner");
    await user.click(within(sheet).getByRole("button", { name: "Mark paid" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Mark paid" })).toBeNull());
    const db = openDb("u1");
    await waitFor(async () =>
      expect((await db.entries.toArray()).filter((e) => e.split_settle)).toHaveLength(1),
    );

    await user.click(screen.getByRole("button", { name: "History" }));
    const history = await screen.findByRole("dialog", { name: "History" });
    const line = within(history)
      .getByText(/You paid Sam \$30\.00 · cash at dinner/)
      .closest("li") as HTMLElement;
    expect(within(history).getByText(/Added Utilities, \$90\.00, by Sam/)).toBeInTheDocument();
    await user.click(within(line).getByRole("button", { name: "Undo" }));
    expect(await within(history).findByText("Undone. It no longer counts.")).toBeInTheDocument();
    expect(
      await within(history).findByText(/You paid Sam \$30\.00 · cash at dinner · undone/),
    ).toBeInTheDocument();
    await waitFor(async () =>
      expect((await db.entries.toArray()).filter((e) => e.split_settle)).toHaveLength(0),
    );
    noSecretsLeft(api, ["cash at dinner"]);
  });

  it("Someone missing? The organizer invites from Add a bill and the bill typed so far stays", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.type(await screen.findByLabelText("1 · How much?"), "60");
    await user.type(screen.getByLabelText("What's it for?"), "Dinner");
    expect(screen.getByText(/Only people in the group can be on a bill\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    const sheet = await screen.findByRole("dialog", { name: "Invite by email" });
    await user.type(within(sheet).getByLabelText("Their email"), "jo@example.com");
    await user.click(within(sheet).getByRole("button", { name: "Send invite" }));
    expect(await within(sheet).findByText(/Invite sent to jo@example.com/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("heading", { level: 1, name: "Add a bill" })).toBeInTheDocument();
    expect(screen.getByLabelText("1 · How much?")).toHaveValue("60");
    expect(screen.getByLabelText("What's it for?")).toHaveValue("Dinner");
    expect(
      await screen.findByText(/Waiting for jo@example\.com: they show here once they join\./),
    ).toBeInTheDocument();
  });

  it("Invites: who each went to, how many are left, never the same inbox twice (November 11, 2026)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}`);
    await user.click(await screen.findByRole("button", { name: "Invite" }));
    let sheet = await screen.findByRole("dialog", { name: "Invite by email" });
    expect(
      within(sheet).getByText("3 of 6 people on your plan · 6 invites left today"),
    ).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Their email"), "Jo@Example.com");
    await user.click(within(sheet).getByRole("button", { name: "Send invite" }));
    await within(sheet).findByText(/Invite sent to Jo@Example.com/);
    await user.keyboard("{Escape}");

    // The list names who it went to (this device remembers; the server keeps only a hash).
    const waiting = await screen.findByRole("region", { name: "Invites waiting" });
    expect(within(waiting).getByText("Jo@Example.com")).toBeInTheDocument();
    expect(within(waiting).getByText("Remind tomorrow")).toBeInTheDocument();
    expect(await openDb("u1").settings.get("split.invited.i2")).toMatchObject({
      value: "Jo@Example.com",
    });

    // The same inbox again: no second invite, and it says when they can be reminded.
    await user.click(screen.getByRole("button", { name: "Invite" }));
    sheet = await screen.findByRole("dialog", { name: "Invite by email" });
    expect(
      await within(sheet).findByText("4 of 6 people on your plan · 5 invites left today"),
    ).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText("Their email"), " jo@example.com ");
    expect(
      within(sheet).getByText(/Already invited .+\. You can remind them again tomorrow\./),
    ).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Send invite" })).toBeNull();
    expect(api.splits.groups[0]?.invites).toHaveLength(1);
  });

  it("Remind: once a day, to the address invited, with a new link", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const g = api.splits.groups[0];
    g?.invites.push(
      {
        id: "inv-known",
        email: "pat@example.com",
        token: "tok_a",
        created_at: twoDaysAgo,
        reminded_at: null,
        expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
      {
        id: "inv-other",
        email: "lee@example.com",
        token: "tok_b",
        created_at: twoDaysAgo,
        reminded_at: null,
        expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      },
    );
    // Only one was sent from this device; the other from a device whose record isn't here.
    await openDb("u1").settings.put({
      key: "split.invited.inv-known",
      value: "pat@example.com",
      updated_at: twoDaysAgo,
    });
    renderApp(`/splits/${gid}`);
    const waiting = await screen.findByRole("region", { name: "Invites waiting" });
    await user.click(
      await within(waiting).findByRole("button", { name: "Remind pat@example.com" }),
    );
    expect(
      await within(waiting).findByText(
        "Reminder sent to pat@example.com. The new link works for the same 7 days.",
      ),
    ).toBeInTheDocument();
    expect(api.splits.invite_reminders).toEqual(["pat@example.com"]);
    expect(await within(waiting).findAllByText("Remind tomorrow")).toHaveLength(1);

    // No address on this device: it asks, refuses another address, then sends and remembers it.
    await user.click(within(waiting).getByRole("button", { name: /^Remind the invite sent/ }));
    const ask = await screen.findByRole("dialog", { name: "Remind them" });
    await user.type(within(ask).getByLabelText("Their email"), "someone@example.com");
    await user.click(within(ask).getByRole("button", { name: "Send reminder" }));
    expect(await within(ask).findByRole("alert")).toHaveTextContent(
      "That isn't the email this invite went to.",
    );
    await user.clear(within(ask).getByLabelText("Their email"));
    await user.type(within(ask).getByLabelText("Their email"), "lee@example.com");
    await user.click(within(ask).getByRole("button", { name: "Send reminder" }));
    await waitFor(() =>
      expect(api.splits.invite_reminders).toEqual(["pat@example.com", "lee@example.com"]),
    );
    expect(await within(waiting).findByText("lee@example.com")).toBeInTheDocument();
    noSecretsLeft(api, ["Apartment 4B"]);
  });

  it("Already invited from another device: the server says so and nothing is sent", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.groups[0]?.invites.push({
      id: "inv-x",
      email: "kim@example.com",
      token: "tok_x",
      created_at: new Date().toISOString(),
      reminded_at: null,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    renderApp(`/splits/${gid}`);
    await user.click(await screen.findByRole("button", { name: "Invite" }));
    const sheet = await screen.findByRole("dialog", { name: "Invite by email" });
    await user.type(within(sheet).getByLabelText("Their email"), "kim@example.com");
    await user.click(within(sheet).getByRole("button", { name: "Send invite" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(
      "They already have an invite waiting. Remind them from Invites waiting.",
    );
    expect(api.splits.groups[0]?.invites).toHaveLength(1);
    expect(api.splits.invites_today).toBe(0);
  });

  it("By item: tax and tip follow what each person had, saved as each person's part (S.8)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.click(await screen.findByRole("radio", { name: "By item" }));
    // One item to start; "+ Add another item" adds more and Remove takes one away.
    expect(screen.queryByRole("button", { name: "Remove item 1" })).toBeNull();
    const add = screen.getByRole("button", { name: "+ Add another item" });
    for (let n = 0; n < 4; n++) await user.click(add);
    await user.click(screen.getByRole("button", { name: "Remove item 5" }));
    expect(screen.queryByLabelText("Item 5, what")).toBeNull();
    // Each person is a chip that fills when picked: the checkbox itself is not drawn.
    expect(
      within(screen.getByRole("group", { name: "Item 1, who had it" })).getByLabelText("You"),
    ).toHaveClass("segmented__input");
    const items: Array<[string, string, string[]]> = [
      ["Steak", "36", ["You"]],
      ["Pasta", "18", ["Sam"]],
      ["Appetizer", "12", ["You", "Sam", "Alex"]],
      ["Salad", "9", ["Alex"]],
    ];
    for (const [i, [what, amount, who]] of items.entries()) {
      await user.type(screen.getByLabelText(`Item ${i + 1}, what`), what);
      await user.type(screen.getByLabelText(`Item ${i + 1}, amount`), amount);
      const chips = screen.getByRole("group", { name: `Item ${i + 1}, who had it` });
      for (const name of who) await user.click(within(chips).getByLabelText(name));
    }
    await user.type(screen.getByLabelText("Tax, tip and fees"), "15");
    expect(await screen.findByText(/Total \$90\.00\./)).toBeInTheDocument();
    expect(await screen.findByText("Only $48.00 counts as yours.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/What's it for/), "Dinner");
    await user.click(screen.getByRole("button", { name: "Add bill" }));
    expect(await screen.findByText("Sam pays you $26.40")).toBeInTheDocument();
    expect(screen.getByText("Alex pays you $15.60")).toBeInTheDocument();
    const mine = await readLedger(api, gid, ME);
    expect(mine.bills.at(-1)).toMatchObject({
      amount_cents: 9000,
      method: "exact",
      values: { [ME]: 4800, [SAM]: 2640, [ALEX]: 1560 },
    });
  });

  it("Split with one person: a group of two behind the scenes, an invite, then Add a bill (S.9)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    renderApp("/splits");
    await user.click(await screen.findByRole("link", { name: "Split with one person" }));
    await user.type(await screen.findByLabelText("Their name"), "Sam");
    await user.type(screen.getByLabelText("Their email"), "sam@example.com");
    await user.type(screen.getByLabelText("Your name, as they'll see it"), "Maya");
    await user.click(screen.getByRole("button", { name: "Invite and add a bill" }));
    expect(await screen.findByLabelText("1 · How much?")).toBeInTheDocument();
    const g = api.splits.groups[0];
    expect(g?.invites.map((i) => i.email)).toEqual(["sam@example.com"]);
    const mine = await readLedger(api, g?.id ?? "", ME);
    expect(mine.group).toMatchObject({ name: "Sam", kind: "one" });
    cleanup();
    renderApp("/splits");
    expect(await screen.findByText("You and Sam")).toBeInTheDocument();
    noSecretsLeft(api, ["You and Sam"]);
  });

  it("confirming a payment someone says they made tells them, in fixed words (S.10)", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    await seedGroceries(api, gid);
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      settlements: [
        {
          id: "s-sam",
          from: SAM,
          to: ME,
          cents: 6200,
          date: "2026-11-08",
          via: "venmo",
          confirms: null,
          at: "2026-11-08T10:00:00Z",
        },
      ],
    });
    renderApp(`/splits/${gid}`);
    const asked = await screen.findByRole("region", { name: /Did they pay you/ });
    await user.click(within(asked).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Confirmed. It's settled for everyone.")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.splits.notified).toEqual([{ kind: "confirmed", member_id: SAM }]),
    );
  });

  it("Spotted: a linked Venmo deposit for what Sam owes is suggested; Mark settled settles it as Paid back", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroceries(api, await seedGroup(api)).then(
      () => api.splits.groups[0]?.id ?? "",
    );
    const db = openDb("u1");
    const linked = (id: string, merchant: string, cents: number) => ({
      id,
      date: "2026-11-07",
      amount_cents: cents,
      direction: "in" as const,
      merchant,
      clean_description: merchant,
      raw_description: merchant,
      category_id: null,
      account_id: "acct-cash",
      source: "linked" as const,
      receipt_id: null,
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      provider_txn_id: `p-${id}`,
      created_at: "2026-11-07T10:00:00Z",
      updated_at: "2026-11-07T10:00:00Z",
    });
    await db.entries.bulkAdd([
      linked("e-venmo", "VENMO CASHOUT SAM L", 6200),
      linked("e-zelle", "ZELLE FROM ALEX", 6200),
    ]);
    renderApp(`/splits/${gid}`);
    const spotted = await screen.findByRole("region", { name: "Spotted" });
    // Each row goes to the person it names.
    const sam = (await within(spotted).findByText(/Is it Sam paying you\?/)).closest(
      ".split-pay",
    ) as HTMLElement;
    const alex = within(spotted)
      .getByText(/Is it Alex paying you\?/)
      .closest(".split-pay") as HTMLElement;
    expect(sam).toHaveTextContent(/came in by VENMO on Nov 7/);
    expect(alex).toHaveTextContent(/came in by Zelle on Nov 7/);
    // Not this on Alex's; Mark settled on Sam's
    await user.click(within(alex).getByRole("button", { name: "Not this" }));
    await waitFor(() => expect(within(spotted).queryByText(/Is it Alex/)).toBeNull());
    await user.click(within(sam).getByRole("button", { name: "Mark settled" }));
    await waitFor(async () => expect((await db.entries.get("e-venmo"))?.paid_back).toBe(true));
    expect((await db.entries.get("e-venmo"))?.not_counted).toBe(true);
    expect((await db.entries.get("e-zelle"))?.paid_back).toBeFalsy();
    expect(await screen.findByText(/Alex pays you \$62\.00/)).toBeInTheDocument();
    // Alex's row was there before; Sam's leaves once the group is pulled again after the payment.
    await waitFor(() => expect(screen.queryByText(/Sam pays you/)).toBeNull());
    await waitFor(() =>
      expect(api.splits.notified).toEqual([{ kind: "confirmed", member_id: SAM }]),
    );
  });

  it("removes someone who owes only by forgiving it; someone owed is settled first", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    await seedGroceries(api, gid);
    renderApp(`/splits/${gid}`);
    const people = await screen.findByRole("list", { name: "People" });
    await user.click(within(people).getByRole("button", { name: /Alex/ }));
    const sheet = await screen.findByRole("dialog", { name: "Remove Alex" });
    expect(within(sheet).getByText(/Settle first: Alex owes \$62\.00/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Forgive $62.00 and remove" }));
    await waitFor(() =>
      expect(api.splits.groups[0]?.members.map((m) => m.member_id)).toEqual([ME, SAM]),
    );
    // Alex's share is forgiven; Sam still owes theirs
    expect(await screen.findByText("Sam pays you $62.00")).toBeInTheDocument();
    expect(screen.queryByText(/Alex pays/)).not.toBeInTheDocument();
  });

  it("Home's Split bills card shows what I'm owed, and hides with no groups", async () => {
    const api = installFakeApi({ session: readySession() });
    renderApp("/");
    await screen.findByRole("link", { name: "Kept this month, open Money in & out" });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/splits")).toBe(true));
    expect(screen.queryByRole("link", { name: "Split bills, open Splits" })).toBeNull();
    cleanup();

    const again = installFakeApi({ session: readySession() });
    const gid = await seedGroup(again);
    await seedGroceries(again, gid);
    renderApp("/");
    const card = await screen.findByRole("link", { name: "Split bills, open Splits" });
    await waitFor(() => expect(card).toHaveTextContent(/Owed\+\$124\.00/));
    expect(card).toHaveTextContent(/pays you \$62\.00/);
  });

  it("the + button's A split goes straight to Add a bill in my only group", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp("/");
    await user.click(await screen.findByRole("button", { name: "Add entry or receipt" }));
    await user.click(await screen.findByRole("button", { name: /A split/ }));
    // The form itself: the screen shows a loading header first, then the form's own, so a
    // heading found early can be gone by the time it's checked (a flake, November 10, 2026).
    expect(await screen.findByLabelText("1 · How much?")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Add a bill" })).toBeInTheDocument();
    expect(api.splits.groups[0]?.id).toBe(gid);
  });

  it("a blocked organizer can't add, invite or ask for money; the tab says why", async () => {
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    await seedGroceries(api, gid);
    api.splits.blocked = true;
    renderApp(`/splits/${gid}`);
    await screen.findByText("Sam pays you $62.00");
    expect(screen.queryByRole("link", { name: "Add a bill" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remind" })).toBeNull();
    cleanup();
    installFakeApi({ session: readySession(), splits: api.splits });
    renderApp("/splits");
    expect(
      await screen.findByText("Reports have paused your groups. Support can look at it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "+ New group" })).toBeNull();
  });

  it("a save that fails after the bill's id was issued retries with the same id", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.type(await screen.findByLabelText("1 · How much?"), "30");
    await user.type(screen.getByLabelText("What's it for?"), "Pizza");
    await screen.findByText("Only $10.00 counts as yours.");
    api.splits.failBlobWrites = 1; // the server fails the save once
    await user.click(screen.getByRole("button", { name: "Add bill" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save");
    expect(api.splits.added_today).toBe(1);
    await user.click(screen.getByRole("button", { name: "Add bill" }));
    expect(await screen.findByText("Sam pays you $10.00")).toBeInTheDocument();
    // One bill, one of the day's count, whatever the retries
    expect(api.splits.added_today).toBe(1);
    expect(api.splits.groups[0]?.bills).toHaveLength(1);
  });

  it("refuses a repeating bill whose first date is too far back to add", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.type(await screen.findByLabelText("1 · How much?"), "30");
    await user.type(screen.getByLabelText("What's it for?"), "Gym");
    await user.click(screen.getByRole("radio", { name: "Weekly" }));
    const date = screen.getByLabelText("First date");
    await user.clear(date);
    await user.type(date, "2010-01-01");
    await screen.findByText("Only $10.00 counts as yours.");
    await user.click(screen.getByRole("button", { name: "Add bill" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("too far back");
    expect(api.splits.added_today).toBe(0);
  });

  it("an approved guest bill can't be changed by its author afterwards", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.groups[0]?.bills.push({ id: "b-clean", created_by: "u-sam", status: "pending" });
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-clean", SAM, 2400, [800, 800, 800], "Cleaning")],
    });
    renderApp(`/splits/${gid}`);
    const waiting = await screen.findByRole("region", { name: "Waiting for your OK" });
    await user.click(within(waiting).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("You pay Sam $8.00")).toBeInTheDocument();
    // Sam rewrites the approved bill to $2,400 in his own ledger
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-clean", SAM, 240000, [80000, 80000, 80000], "Cleaning")],
    });
    cleanup();
    installFakeApi({ session: readySession(), splits: api.splits });
    renderApp(`/splits/${gid}`);
    expect(await screen.findByText("You pay Sam $8.00")).toBeInTheDocument();
    expect(screen.queryByText(/\$800\.00/)).toBeNull();
  });

  it("stops at the day's limit: Done for today", async () => {
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.added_today = 6;
    renderApp(`/splits/${gid}`);
    expect(
      await screen.findByText("Done for today · 6 of 6 bills added. More tomorrow at midnight."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add a bill" })).not.toBeInTheDocument();
  });

  it("with double-check on, an invite needs the email twice and a bill needs a tick", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    api.splits.double_check = true;
    renderApp(`/splits/${gid}`);
    expect(
      await screen.findByText(/3 recent invites or bills came back as mistakes/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invite" }));
    const sheet = await screen.findByRole("dialog", { name: "Invite by email" });
    await user.type(within(sheet).getByLabelText("Their email"), "jo@example.com");
    await user.type(within(sheet).getByLabelText("Their email again"), "jo@example.co");
    await user.click(within(sheet).getByRole("button", { name: "Send invite" }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("The two emails don't match.");
    expect(within(sheet).getByLabelText("Their email again")).toHaveFocus();
    expect(api.splits.groups[0]?.invites ?? []).toHaveLength(0);
    await user.type(within(sheet).getByLabelText("Their email again"), "m");
    expect(within(sheet).queryByRole("alert")).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("link", { name: "Add a bill" }));
    await user.type(await screen.findByLabelText("1 · How much?"), "30");
    await user.type(screen.getByLabelText("What's it for?"), "Pizza");
    await screen.findByText("Only $10.00 counts as yours.");
    await user.click(screen.getByRole("button", { name: "Add bill" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tick “Amount and people right?” first.");
    const tick = screen.getByRole("checkbox", { name: "Amount and people right?" });
    expect(tick).toHaveFocus();
    await user.click(tick);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add bill" }));
    await screen.findByRole("heading", { level: 1, name: "Apartment 4B" });
  });

  it("with double-check on, the organizer's edit saves: the tick is only asked when adding", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    await seedGroceries(api, gid);
    api.splits.double_check = true;
    renderApp(`/splits/${gid}/bills/b-groc`);
    const what = await screen.findByLabelText("What's it for?");
    expect(screen.queryByRole("checkbox", { name: "Amount and people right?" })).toBeNull();
    await user.clear(what);
    await user.type(what, "Groceries and soap");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("heading", { level: 1, name: "Apartment 4B" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["the group", (gid: string) => `/splits/${gid}`, "Apartment 4B"],
    ["Add a bill", (gid: string) => `/splits/${gid}/bills/new`, "Add a bill"],
    ["Edit bill", (gid: string) => `/splits/${gid}/bills/b-groc`, "Edit bill"],
  ])("%s has no axe violations", async (_name, path, heading) => {
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    await seedGroceries(api, gid);
    api.splits.groups[0]?.bills.push({ id: "b-clean", created_by: "u-sam", status: "pending" });
    await writeLedger(api, gid, SAM, {
      ...emptyLedger(),
      bills: [bill("b-clean", SAM, 2400, [800, 800, 800], "Cleaning")],
      settlements: [
        {
          id: "s1",
          from: SAM,
          to: ME,
          cents: 1000,
          date: "2026-11-08",
          via: "venmo",
          confirms: null,
          at: "2026-11-08T10:00:00Z",
        },
      ],
    });
    const { container } = renderApp(path(gid));
    await screen.findByRole("heading", { level: 1, name: heading });
    if (heading === "Apartment 4B") await screen.findByText(/says they paid you/);
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
