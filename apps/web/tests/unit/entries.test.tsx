import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

async function renderSignedIn(path: string) {
  installFakeApi({ session: readySession() });
  const result = renderApp(path);
  await screen.findByRole("navigation", { name: "Primary" });
  return result;
}

describe("manual entries live only on the device", () => {
  it("adds an entry from the + button, parsed by the engine, and lists it", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/");
    expect(
      await screen.findByText("Nothing yet. Tap + to add what you spent or earned."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add entry or receipt" }));
    await user.click(await screen.findByRole("button", { name: /An entry/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Add entry" })).toBeInTheDocument();

    expect(screen.getByRole("radio", { name: "Money out" })).toBeChecked();
    const chips = screen.getByRole("group", { name: "Category" });
    expect(
      within(chips)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toHaveLength(12);
    await user.type(screen.getByLabelText("Amount"), "1,234.56");
    await user.type(screen.getByLabelText("Merchant"), "Corner Market");
    expect(screen.getByLabelText("Account")).toHaveDisplayValue("Cash");
    await user.click(within(chips).getByRole("radio", { name: "Groceries" }));
    expect(screen.getByText("Saved on this device only.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Money in & out" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Corner Market")).toBeInTheDocument();
    expect(screen.getByText("−$1,234.56")).toBeInTheDocument();
    expect(screen.getByText("Cash · Groceries")).toBeInTheDocument();

    const rows = await openDb("u1").entries.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount_cents: 123456,
      direction: "out",
      source: "manual",
      category_id: "cat-groceries",
    });
  });

  it("money in shows the income categories and a plus amount", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/add");
    await user.click(await screen.findByRole("radio", { name: "Money in" }));
    const chips = screen.getByRole("group", { name: "Category" });
    expect(
      within(chips)
        .getAllByRole("radio")
        .map((r) => r.parentElement?.textContent),
    ).toEqual(["Paycheck", "Side income", "Refund", "Other"]);
    await user.type(screen.getByLabelText("Amount"), "2400");
    await user.click(within(chips).getByRole("radio", { name: "Paycheck" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("+$2,400.00")).toBeInTheDocument();
    expect(screen.getByText("Money in")).toBeInTheDocument();
  });

  it("rejects an amount the engine cannot parse", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/add");
    await user.type(await screen.findByLabelText("Amount"), "12..5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an amount like 42.17.");
    expect(await openDb("u1").entries.count()).toBe(0);
  });

  it("edits and deletes an entry, and Home shows recent ones", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await db.entries.add({
      id: "e1",
      date: "2026-10-09",
      amount_cents: 4217,
      direction: "out",
      merchant: "Corner Market",
      clean_description: "Corner Market",
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
      created_at: "2026-10-09T10:00:00Z",
      updated_at: "2026-10-09T10:00:00Z",
    });
    // A receipt photo kept for it: deleting the entry deletes the photo too
    await db.files.add({
      id: "f-r1",
      kind: "receipt",
      import_id: null,
      name: "receipt.jpg",
      type: "image/jpeg",
      size: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      created_at: "2026-10-09T10:00:00Z",
    });
    await db.receipts.add({
      id: "r1",
      entry_id: "e1",
      file_id: "f-r1",
      status: "confirmed",
      purge_after: null,
      purged_at: null,
      created_at: "2026-10-09T10:00:00Z",
      updated_at: "2026-10-09T10:00:00Z",
    });
    await renderSignedIn("/");
    const recent = await screen.findByRole("region", { name: "Recent entries" });
    await user.click(await within(recent).findByRole("button", { name: /Corner Market/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Edit entry" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Merchant")).toHaveValue("Corner Market"));
    await user.clear(screen.getByLabelText("Merchant"));
    await user.type(screen.getByLabelText("Merchant"), "Corner Mkt");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Corner Mkt")).toBeInTheDocument();
    expect((await db.entries.get("e1"))?.merchant).toBe("Corner Mkt");

    await user.click(screen.getByRole("button", { name: /Corner Mkt/ }));
    await user.click(await screen.findByRole("button", { name: "Delete entry" }));
    await user.click(screen.getByRole("button", { name: "Really delete this entry" }));
    expect(await screen.findByText("No entries this month. Tap + to add one.")).toBeInTheDocument();
    expect(await db.entries.count()).toBe(0);
    expect(await db.receipts.count()).toBe(0);
    expect(await db.files.count()).toBe(0);
  });

  it("the month switcher asks the engine for bounds", async () => {
    const user = userEvent.setup();
    await renderSignedIn("/entries");
    const label = await screen.findByText(/\d{4}$/);
    const before = label.textContent;
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(label.textContent).not.toBe(before));
    await user.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() => expect(label.textContent).toBe(before));
  });

  it("Me shows the entry count and persistence state", async () => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => ({ usage: 1024, quota: 1e9 }),
      },
    });
    try {
      await renderSignedIn("/me/data");
      const section = await screen.findByRole("region", { name: "Receipts & your data" });
      expect(
        await within(section).findByText("This browser has agreed to keep it."),
      ).toBeInTheDocument();
      expect(section).toHaveTextContent("0 entries, stored only on this device (1 KB used).");
    } finally {
      // @ts-expect-error test cleanup
      delete navigator.storage;
    }
  });
});
