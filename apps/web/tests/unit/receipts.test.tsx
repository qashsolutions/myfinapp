import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb } from "../../src/data/db.ts";
import { type FakeApi, installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

// The OCR engine is exercised for real in receipt-ocr-engine.test.ts (node); here it is a
// stand-in so the card's flow is tested without WebAssembly in jsdom.
const PHOTO_TEXT =
  "CORNER MARKET\n10/09/2026 14:32\nMilk 3.49\nSUBTOTAL 11.00\nTAX 0.91\nTOTAL 11.91";
vi.mock("../../src/features/receipts/ocr/engine.ts", () => ({
  OcrError: class OcrError extends Error {},
  readReceiptText: vi.fn(async () => ({ text: PHOTO_TEXT, engine_version: "fake-ocr 1" })),
}));

function seg(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
}
const EXIF = seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53]);
const BODY = [
  ...seg(0xdb, [0, ...new Array(64).fill(1)]),
  ...seg(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0]),
  ...seg(0xda, [1, 1, 0, 0, 63, 0]),
  0x12,
  0xff,
  0xd9,
];
const PHOTO = new File(
  [new Uint8Array([0xff, 0xd8, ...EXIF, ...BODY]).buffer as ArrayBuffer],
  "IMG_0042.jpg",
  {
    type: "image/jpeg",
  },
);

describe("receipt photos", () => {
  let api: FakeApi;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    api = installFakeApi({ session: readySession() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches a photo from the + button, strips its metadata, keeps it on the device for 90 days", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("navigation", { name: "Primary" });
    await user.click(screen.getByRole("button", { name: "Add entry or receipt" }));
    await user.click(await screen.findByRole("button", { name: /A receipt/ }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Add entry from a receipt" }),
    ).toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Receipt photo" });
    expect(card).toHaveTextContent("Kept on this device for 90 days");
    await user.upload(within(card).getByLabelText("Add a receipt photo"), PHOTO);
    await waitFor(() => expect(card).toHaveTextContent("Receipt photo attached"));
    expect(card).toHaveTextContent("until Jan 8, 2027");
    // Read text from photo runs on this device and only suggests; the user applies it
    await user.click(within(card).getByRole("button", { name: "Read text from photo" }));
    const suggest = await within(card).findByRole("group", { name: "Read from the photo" });
    expect(suggest).toHaveTextContent("Merchant: Corner Market");
    expect(suggest).toHaveTextContent("Date: Oct 9");
    expect(suggest).toHaveTextContent("Total: $11.91");
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    await user.click(within(suggest).getByRole("button", { name: "Use these" }));
    expect(screen.getByLabelText("Amount")).toHaveValue("11.91");
    expect(screen.getByLabelText("Merchant")).toHaveValue("Corner Market");
    expect(screen.getByLabelText("Date")).toHaveValue("2026-10-09");
    expect(within(card).queryByRole("group", { name: "Read from the photo" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Money in & out" }),
    ).toBeInTheDocument();

    const db = openDb("u1");
    const entries = await db.entries.toArray();
    const receipts = await db.receipts.toArray();
    const files = await db.files.toArray();
    expect(entries).toHaveLength(1);
    expect(receipts).toHaveLength(1);
    expect(files).toHaveLength(1);
    expect(entries[0]?.receipt_id).toBe(receipts[0]?.id);
    expect(receipts[0]).toMatchObject({
      entry_id: entries[0]?.id,
      status: "confirmed",
      purge_after: "2027-01-08",
      file_id: files[0]?.id,
      ocr_text: PHOTO_TEXT,
      ocr_engine_version: "fake-ocr 1",
    });
    expect(entries[0]).toMatchObject({
      amount_cents: 1191,
      merchant: "Corner Market",
      date: "2026-10-09",
    });
    // The stored size is the stripped size: the EXIF segment is gone (the bytes themselves are
    // checked in receipts-strip.test.ts; fake-indexeddb cannot hand a jsdom Blob back).
    expect(files[0]).toMatchObject({ kind: "receipt", type: "image/jpeg", size: 2 + BODY.length });
    expect(PHOTO.size).toBe(2 + EXIF.length + BODY.length);
    // Nothing left the device
    expect(
      api.calls.filter(
        (c) =>
          ![
            "/api/auth/session",
            "/api/groups",
            "/api/notifications/settings",
            "/api/alerts/schedule",
            // Home's restore offer on a plan with backup: two reads, no body
            "/api/billing/entitlements",
            "/api/backup",
          ].includes(c.path),
      ),
    ).toEqual([]);

    // The entry editor shows the photo; retention can change under Me
    await user.click(await screen.findByText("Corner Market"));
    const editCard = await screen.findByRole("region", { name: "Receipt photo" });
    await waitFor(() => expect(editCard).toHaveTextContent("Receipt photo attached"));
  });

  it("replacing an entry's photo deletes the old receipt and its photo", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    await db.files.add({
      id: "f-old",
      kind: "receipt",
      import_id: null,
      name: "old.jpg",
      type: "image/jpeg",
      size: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      created_at: "2026-10-09T10:00:00Z",
    });
    await db.receipts.add({
      id: "r-old",
      entry_id: "e1",
      file_id: "f-old",
      status: "confirmed",
      purge_after: null,
      purged_at: null,
      created_at: "2026-10-09T10:00:00Z",
      updated_at: "2026-10-09T10:00:00Z",
    });
    await db.entries.add({
      id: "e1",
      date: "2026-10-09",
      amount_cents: 1191,
      direction: "out",
      merchant: "Corner Market",
      clean_description: "CORNER MARKET",
      raw_description: null,
      category_id: "cat-groceries",
      account_id: "acct-cash",
      source: "manual",
      receipt_id: "r-old",
      import_id: null,
      is_transfer: false,
      transfer_pair_id: null,
      split_parent_id: null,
      is_recurring: false,
      created_at: "2026-10-09T10:00:00Z",
      updated_at: "2026-10-09T10:00:00Z",
    });
    renderApp("/entries/e1");
    await waitFor(() => expect(screen.getByLabelText("Merchant")).toHaveValue("Corner Market"));
    const card = await screen.findByRole("region", { name: "Receipt photo" });
    // The card draws its picker again once the stored photo is in; use that one
    await waitFor(() => expect(card).toHaveTextContent("Receipt photo attached"));
    await user.upload(within(card).getByLabelText("Replace photo"), PHOTO);
    await waitFor(async () => expect(await db.receipts.count()).toBe(2));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Money in & out" });
    const receipts = await db.receipts.toArray();
    expect(receipts.map((r) => r.entry_id)).toEqual(["e1"]);
    expect(receipts[0]?.id).not.toBe("r-old");
    expect(await db.files.get("f-old")).toBeUndefined();
    expect(await db.files.count()).toBe(1);
    expect((await db.entries.get("e1"))?.receipt_id).toBe(receipts[0]?.id);
  });

  it("the retention setting re-dates photos, and expired ones are removed on the next open while the entry stays", async () => {
    const user = userEvent.setup();
    const db = openDb("u1");
    renderApp("/add?with=receipt");
    await screen.findByRole("navigation", { name: "Primary" });
    const card = await screen.findByRole("region", { name: "Receipt photo" });
    await user.upload(within(card).getByLabelText("Add a receipt photo"), PHOTO);
    await waitFor(() => expect(card).toHaveTextContent("until Jan 8, 2027"));
    await user.type(screen.getByLabelText("Amount"), "9.50");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Money in & out" });

    await user.click(screen.getByRole("link", { name: "Me" }));
    await user.click(await screen.findByRole("link", { name: /Money & data/ }));
    const section = await screen.findByRole("region", { name: "Receipt photos" });
    await user.click(within(section).getByRole("radio", { name: "1 year" }));
    await waitFor(async () =>
      expect((await db.receipts.toArray())[0]?.purge_after).toBe("2027-10-10"),
    );
    await user.click(within(section).getByRole("radio", { name: "Forever" }));
    await waitFor(async () => expect((await db.receipts.toArray())[0]?.purge_after).toBeNull());
    await user.click(within(section).getByRole("radio", { name: "90 days" }));
    await waitFor(async () =>
      expect((await db.receipts.toArray())[0]?.purge_after).toBe("2027-01-08"),
    );

    // 91 days later the app opens: the photo goes, the receipt row and the entry stay
    vi.setSystemTime(new Date("2027-01-09T09:00:00"));
    renderApp("/");
    await screen.findByRole("navigation", { name: "Primary" });
    await waitFor(async () => expect(await db.files.count()).toBe(0));
    const receipt = (await db.receipts.toArray())[0];
    expect(receipt).toMatchObject({ file_id: null, status: "confirmed" });
    expect(receipt?.purged_at).not.toBeNull();
    expect(await db.entries.count()).toBe(1);
    expect((await db.entries.toArray())[0]?.amount_cents).toBe(950);
  });
});
