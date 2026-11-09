// Split bills, guests and safety (chunk S.4): the invite card and join, the two-tab guest app,
// How friends pay me, Check first before paying, Payments I confirmed, disputes and Report and
// leave. Handles and amounts never leave readable (invariant 78); the server gets the Check
// first warning's version only.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import {
  encryptJson,
  fromBase64url,
  randomBytes,
  toBase64url,
} from "../../src/data/backup/crypto.ts";
import { openDb } from "../../src/data/db.ts";
import { emptyLedger, type SplitBill } from "../../src/features/splits/ledger.ts";
import { blobAad, rememberGroupKey } from "../../src/features/splits/splitSync.ts";
import { type FakeApi, freeBilling, installFakeApi, readySession } from "../fakeApi.ts";
import type { FakeSplitMember } from "../fakeSplits.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-11-08T12:00:00");
const GID = "sg-j";
const JORDAN = "m-jordan";
const ME = "m-u1";
const KEY = toBase64url(randomBytes(32));
const TOKEN = "tok_abcdefghijklmnopqrst";
const AT = "2026-11-01T10:00:00Z";

const jordan: FakeSplitMember = {
  member_id: JORDAN,
  user_id: "u-jordan",
  display_name: "Jordan K.",
  guest: false,
  joined_at: AT,
};
const meMember: FakeSplitMember = {
  member_id: ME,
  user_id: "u1",
  display_name: "Maya R.",
  guest: true,
  joined_at: AT,
};

function guestApi(opts: { inGroup: boolean }): FakeApi {
  const api = installFakeApi({
    session: readySession(),
    billing: freeBilling(),
    access: { state: "choose", plan: "free", trial_used: false, split_guest: opts.inGroup },
  });
  api.splits.groups.push({
    id: GID,
    organizer_user: "u-jordan",
    members: opts.inGroup ? [jordan, meMember] : [jordan],
    invites: [],
    bills: [{ id: "b-net", created_by: "u-jordan", status: "approved" }],
    blobs: [],
    keys: [],
    disputes: [],
    guests_can_add: true,
    writable: true,
    reported: false,
  });
  return api;
}

async function blob(api: FakeApi, member: string, kind: "ledger" | "profile", value: unknown) {
  const g = api.splits.groups[0];
  if (!g) throw new Error("no group");
  const sealed = await encryptJson(fromBase64url(KEY), value, blobAad(GID, kind, member));
  g.blobs = g.blobs.filter((x) => !(x.member_id === member && x.kind === kind));
  g.blobs.push({
    member_id: member,
    kind,
    ciphertext: toBase64url(sealed),
    version: 1,
    updated_at: AT,
  });
}

const internet: SplitBill = {
  id: "b-net",
  date: "2026-11-03",
  what: "Internet",
  amount_cents: 9000,
  paid_by: JORDAN,
  people: [JORDAN, ME],
  method: "equal",
  values: null,
  leftover_to: JORDAN,
  parts: [
    { person: JORDAN, cents: 4500 },
    { person: ME, cents: 4500 },
  ],
  repeat: null,
  repeat_until: null,
  added_by: JORDAN,
  updated_at: AT,
};

/** Jordan's group as the guest's device sees it: the name, Internet $90, Jordan's Venmo. */
async function jordansGroup(api: FakeApi, venmoChanged = "2026-10-20T10:00:00Z") {
  await rememberGroupKey(openDb("u1"), GID, KEY);
  await blob(api, JORDAN, "ledger", {
    ...emptyLedger(),
    bills: [internet],
    group: {
      name: "Lake house",
      kind: "trip",
      usual_method: "equal",
      leftover: "payer",
      updated_at: AT,
    },
  });
  await blob(api, JORDAN, "profile", {
    v: 1,
    name: "Jordan K.",
    handles: { venmo: "jordan-k" },
    changed: { venmo: venmoChanged },
    saved_at: venmoChanged,
  });
}

describe("Split bills: guests and safety", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a new guest joins from the email link: the invite card, then an app of Splits and Me", async () => {
    const user = userEvent.setup();
    const api = guestApi({ inGroup: false });
    await blob(api, JORDAN, "ledger", {
      ...emptyLedger(),
      group: {
        name: "Lake house",
        kind: "trip",
        usual_method: "equal",
        leftover: "payer",
        updated_at: AT,
      },
    });
    api.splits.inbox.push({
      token: TOKEN,
      group_id: GID,
      email: "maya.r@example.com",
      organizer_name: "Jordan K.",
      organizer_email: "j•••@gmail.com",
      member_since: "2026-10",
      pays_with_card: true,
      member: meMember,
    });
    renderApp(`/splits/join#t=${TOKEN}&k=${KEY}`);
    const card = await screen.findByRole("region", { name: "Who's inviting you" });
    expect(card).toHaveTextContent("Jordan K. invited you to split bills");
    expect(card).toHaveTextContent("j•••@gmail.com");
    expect(card).toHaveTextContent("On Qash since October 2026");
    expect(card).toHaveTextContent("Pays for Qash with a US card");
    expect(card).toHaveTextContent("1 person in the group");

    api.access = { state: "choose", plan: "free", trial_used: false, split_guest: true };
    await user.click(screen.getByRole("button", { name: "I know Jordan K. · Join" }));
    // Nobody joins nameless: the group sees who they are
    expect(await screen.findByRole("alert")).toHaveTextContent("Add your name");
    await user.type(screen.getByLabelText("Your name, as the group sees it"), "Maya R.");
    await user.click(screen.getByRole("button", { name: "I know Jordan K. · Join" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Lake house" }),
    ).toBeInTheDocument();
    expect((await openDb("u1").settings.get(`split.key.${GID}`))?.value).toBe(KEY);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ).toEqual(["Splits", "Me"]),
    );
    expect(screen.queryByRole("button", { name: "Add entry or receipt" })).toBeNull();
    // The key in the link never left the device
    for (const c of api.calls) expect(`${c.url} ${c.raw}`).not.toContain(KEY);
  });

  it("I don't know them: nobody is added and they can't ask this inbox again", async () => {
    const user = userEvent.setup();
    const api = guestApi({ inGroup: false });
    api.splits.inbox.push({
      token: TOKEN,
      group_id: GID,
      email: "maya.r@example.com",
      organizer_name: "Jordan K.",
      organizer_email: "j•••@gmail.com",
      member_since: "2026-10",
      pays_with_card: false,
      member: meMember,
    });
    renderApp(`/splits/join#t=${TOKEN}`);
    await user.click(await screen.findByRole("button", { name: "I don't know Jordan K." }));
    expect(await screen.findByText(/Jordan K. can't invite this email again/)).toBeInTheDocument();
    expect(api.splits.declined).toEqual([TOKEN]);
    expect(api.splits.groups[0]?.members).toHaveLength(1);
  });

  it("an invite for another inbox says so", async () => {
    const api = guestApi({ inGroup: false });
    api.splits.inbox.push({
      token: TOKEN,
      group_id: GID,
      email: "someone.else@example.com",
      organizer_name: "Jordan K.",
      organizer_email: "j•••@gmail.com",
      member_since: "2026-10",
      pays_with_card: false,
      member: meMember,
    });
    renderApp(`/splits/join#t=${TOKEN}`);
    expect(await screen.findByText(/This invite is for a different email/)).toBeInTheDocument();
  });

  it("a guest lands on Splits: Home and Budget aren't theirs", async () => {
    const api = guestApi({ inGroup: true });
    await jordansGroup(api);
    renderApp("/budget");
    expect(await screen.findByRole("heading", { level: 1, name: "Splits" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Lake house/ })).toBeInTheDocument();
  });

  it("pays through Check first: two ticks, the warning's version to the server, the rest kept here", async () => {
    const user = userEvent.setup();
    const api = guestApi({ inGroup: true });
    await jordansGroup(api);
    renderApp(`/splits/${GID}`);
    const row = (await screen.findByText("You pay Jordan K. $45.00")).closest(
      ".split-pay",
    ) as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Pay" }));
    const sheet = await screen.findByRole("dialog", { name: "Check first" });
    expect(sheet).toHaveTextContent("Money you send can't be pulled back.");
    expect(sheet).toHaveTextContent("Venmo @jordan-k · saved Oct 20");
    expect(within(sheet).queryByText(/Changed recently/)).toBeNull();
    const go = within(sheet).getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    await user.click(
      within(sheet).getByRole("checkbox", { name: "I know Jordan K. in real life." }),
    );
    expect(go).toBeDisabled();
    await user.click(
      within(sheet).getByRole("checkbox", { name: "I checked the bills and I owe this amount." }),
    );
    await user.click(go);
    const open = await within(sheet).findByRole("link", { name: "Open Venmo · $45.00" });
    expect(open).toHaveAttribute("href", "https://venmo.com/jordan-k?txn=pay&amount=45.00");
    expect(api.splits.consents).toEqual([JSON.stringify({ version: "2026-11-08" })]);
    expect(await openDb("u1").split_payments.toArray()).toMatchObject([
      { group_id: GID, to_name: "Jordan K.", cents: 4500, app: "venmo", handle: "jordan-k" },
    ]);

    await user.click(within(sheet).getByRole("button", { name: "I've paid · Mark paid" }));
    // Recorded by the payer: a claim until Jordan confirms it
    expect(
      await screen.findByText("Waiting for Jordan K. to confirm your $45.00."),
    ).toBeInTheDocument();
    for (const c of api.calls)
      for (const secret of ["jordan-k", "Internet", "Lake house", "4500"])
        if (!/\/blobs\//.test(c.path)) expect(`${c.url} ${c.raw}`).not.toContain(secret);
  });

  it("a handle changed in the last 3 days says to check with them first", async () => {
    const user = userEvent.setup();
    const api = guestApi({ inGroup: true });
    await jordansGroup(api, "2026-11-07T09:00:00Z");
    renderApp(`/splits/${GID}`);
    const row = (await screen.findByText("You pay Jordan K. $45.00")).closest(
      ".split-pay",
    ) as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Pay" }));
    const sheet = await screen.findByRole("dialog", { name: "Check first" });
    expect(within(sheet).getByRole("alert")).toHaveTextContent(
      "Changed recently · check with Jordan K. before you pay.",
    );
  });

  it("How friends pay me: checked, saved encrypted in each group, never readable", async () => {
    const user = userEvent.setup();
    const api = guestApi({ inGroup: true });
    await jordansGroup(api);
    renderApp("/me/split-pay");
    const venmo = await screen.findByLabelText("Venmo");
    await user.type(venmo, "@ab");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/5 to 30 letters/);
    await user.clear(venmo);
    await user.type(venmo, "@maya-r");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved in 1 group.")).toBeInTheDocument();
    const mine = api.splits.groups[0]?.blobs.find(
      (x) => x.member_id === ME && x.kind === "profile",
    );
    expect(mine).toBeTruthy();
    for (const c of api.calls) expect(`${c.url} ${c.raw}`).not.toContain("maya-r");
  });

  it("disputes a bill: on hold for everyone until it's fixed", async () => {
    const user = userEvent.setup();
    const api = guestApi({ inGroup: true });
    await jordansGroup(api);
    renderApp(`/splits/${GID}`);
    await screen.findByText("You pay Jordan K. $45.00");
    await user.click(screen.getByRole("button", { name: /Internet/ }));
    const sheet = await screen.findByRole("dialog", { name: "Internet" });
    await user.click(within(sheet).getByRole("button", { name: "This isn't right · Dispute" }));
    await waitFor(() =>
      expect(api.splits.groups[0]?.disputes).toEqual([{ bill_id: "b-net", member_id: ME }]),
    );
    expect(await screen.findByText(/1 disputed bill is on hold/)).toBeInTheDocument();
    expect(screen.queryByText("You pay Jordan K. $45.00")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Internet/ }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Internet" })).getByRole("button", {
        name: "Withdraw my dispute",
      }),
    );
    expect(await screen.findByText("You pay Jordan K. $45.00")).toBeInTheDocument();
  });

  it("Report and leave sends a reason and nothing else; leaving never forgives the balance", async () => {
    const user = userEvent.setup();
    const api = guestApi({ inGroup: true });
    await jordansGroup(api);
    renderApp(`/splits/${GID}`);
    await screen.findByText("You pay Jordan K. $45.00");
    await user.click(screen.getByRole("button", { name: "Leave or report" }));
    const sheet = await screen.findByRole("dialog", { name: "Leave group" });
    expect(sheet).toHaveTextContent("Leaving doesn't forgive anything: you still owe $45.00.");
    await user.click(
      within(sheet).getByRole("button", { name: "Something's wrong? Report and leave" }),
    );
    const report = await screen.findByRole("dialog", { name: "Report and leave" });
    await user.click(within(report).getByRole("radio", { name: "I don't know them" }));
    await user.click(within(report).getByRole("button", { name: "Report and leave" }));
    await waitFor(() => expect(api.splits.left).toEqual([{ group_id: GID, report: "dont_know" }]));
  });

  it("Payments I confirmed lists each Check first", async () => {
    installFakeApi({ session: readySession() });
    await openDb("u1").split_payments.put({
      id: "p1",
      group_id: GID,
      to_name: "Jordan K.",
      to_member: JORDAN,
      cents: 4500,
      app: "venmo",
      handle: "jordan-k",
      knows_them: true,
      owes_this: true,
      warning_version: "2026-11-08",
      at: "2026-11-08T15:04:00Z",
      updated_at: "2026-11-08T15:04:00Z",
    });
    renderApp("/me/split-payments");
    await screen.findByText("Jordan K. · $45.00");
    const list = screen.getByRole("list", { name: "Payments I confirmed" });
    expect(list).toHaveTextContent("Venmo @jordan-k · I know them · I checked the bills");
  });

  it.each([
    ["the invite card", `/splits/join#t=${TOKEN}`, "Split bills invite"],
    ["How friends pay me", "/me/split-pay", "How friends pay me"],
    ["Payments I confirmed", "/me/split-payments", "Payments I confirmed"],
    ["the guest's Me", "/me", "Me"],
    ["the guest's group", `/splits/${GID}`, "Lake house"],
  ])("%s has no axe violations", async (_n, path, heading) => {
    const api = guestApi({ inGroup: true });
    await jordansGroup(api);
    api.splits.inbox.push({
      token: TOKEN,
      group_id: GID,
      email: "maya.r@example.com",
      organizer_name: "Jordan K.",
      organizer_email: "j•••@gmail.com",
      member_since: "2026-10",
      pays_with_card: true,
      member: meMember,
    });
    const { container } = renderApp(path);
    await screen.findByRole("heading", { level: 1, name: heading });
    if (path.startsWith("/splits/join"))
      await screen.findByRole("region", { name: "Who's inviting you" });
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
