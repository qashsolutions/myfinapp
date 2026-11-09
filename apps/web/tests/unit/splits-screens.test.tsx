// Split bills, the organizer's screens (chunk S.3b): a group from Goals → Splits, invites, a
// bill through the engine, a guest's bill waiting for the OK, Mark paid, Remove, the day's limit
// and double-check. Nothing readable about a bill or a group's name leaves the device (78).

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { encryptJson, toBase64url } from "../../src/data/backup/crypto.ts";
import { openDb } from "../../src/data/db.ts";
import { emptyLedger, type LedgerBlob, type SplitBill } from "../../src/features/splits/ledger.ts";
import { blobAad, groupKey } from "../../src/features/splits/splitSync.ts";
import { createSplitGroup } from "../../src/features/splits/useSplits.ts";
import { type FakeApi, installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-11-08T12:00:00");
const ME = "m-u1";
const SAM = "m-u-sam";
const ALEX = "m-u-alex";

function noSecretsLeft(api: FakeApi, words: string[]) {
  for (const call of api.calls) {
    const text = `${call.url} ${call.raw}`;
    for (const w of words) expect(text, `${call.method} ${call.path}`).not.toContain(w);
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
  const old = g.blobs.find((b) => b.member_id === member && b.kind === "ledger");
  const row = {
    member_id: member,
    kind: "ledger",
    ciphertext: toBase64url(await encryptJson(key, ledger, blobAad(gid, "ledger", member))),
    version: (old?.version ?? 0) + 1,
    updated_at: new Date().toISOString(),
  };
  g.blobs = [...g.blobs.filter((b) => b !== old), row];
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
  const mine = g?.blobs.find((b) => b.member_id === ME);
  const { decryptJson, fromBase64url } = await import("../../src/data/backup/crypto.ts");
  const current = mine
    ? await decryptJson<LedgerBlob>(key, fromBase64url(mine.ciphertext), blobAad(gid, "ledger", ME))
    : emptyLedger();
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
    renderApp("/goals?tab=splits");
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
    noSecretsLeft(api, ["Apartment", "4B"]);
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

  it("splits by shares with the leftover cent to the person the organizer picks", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    const gid = await seedGroup(api);
    renderApp(`/splits/${gid}/bills/new`);
    await user.type(await screen.findByLabelText("1 · How much?"), "100");
    await user.click(screen.getByRole("radio", { name: "Shares" }));
    await user.type(screen.getByLabelText("You, shares"), "1");
    await user.type(screen.getByLabelText("Sam, shares"), "1");
    await user.type(screen.getByLabelText("Alex, shares"), "1");
    await user.selectOptions(screen.getByLabelText("A leftover cent goes to"), "Sam");
    // $100 ÷ 3 = $33.33 each, the leftover cent to Sam
    expect(await screen.findByText("Only $33.33 counts as yours.")).toBeInTheDocument();
    expect(screen.getByText("$33.34")).toBeInTheDocument();
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
    noSecretsLeft(api, ["5000", "Groceries"]);
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
    expect(
      await screen.findByRole("heading", { level: 1, name: "Add a bill" }),
    ).toBeInTheDocument();
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
    renderApp("/goals?tab=splits");
    expect(
      await screen.findByText("Reports have paused your groups. Support can look at it."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "+ New group" })).toBeNull();
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
    expect(within(sheet).getByRole("button", { name: "Send invite" })).toBeDisabled();
    await user.type(within(sheet).getByLabelText("Their email again"), "m");
    expect(within(sheet).getByRole("button", { name: "Send invite" })).toBeEnabled();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("link", { name: "Add a bill" }));
    await user.type(await screen.findByLabelText("1 · How much?"), "30");
    await user.type(screen.getByLabelText("What's it for?"), "Pizza");
    await screen.findByText("Only $10.00 counts as yours.");
    expect(screen.getByRole("button", { name: "Add bill" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Amount and people right?" }));
    expect(screen.getByRole("button", { name: "Add bill" })).toBeEnabled();
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
