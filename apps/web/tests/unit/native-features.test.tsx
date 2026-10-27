/**
 * Chunk 2.3, the web half of the native features: inside a shell (a faked Capacitor global)
 * the camera feeds the same metadata-stripping path, push registration sends only a platform
 * and a token, passkey ceremonies go through the StackdPasskeys plugin, and Home hands the
 * widget its strings. In a browser none of this exists (the PWA tests elsewhere prove that).
 */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Entry, openDb, seedDefaults } from "../../src/data/db.ts";
import { assertPasskey, registerPasskey } from "../../src/features/security/webauthn.ts";
import { subscribeToPush, unsubscribeFromPush } from "../../src/pwa/pushSubscribe.ts";
import { type FakeApi, installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

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
const JPEG = new Uint8Array([0xff, 0xd8, ...EXIF, ...BODY]);

// The OCR engine never runs here; the suggestion flow is covered in receipts.test.tsx.
vi.mock("../../src/features/receipts/ocr/engine.ts", () => ({
  OcrError: class OcrError extends Error {},
  readReceiptText: vi.fn(async () => ({ text: "", engine_version: "fake" })),
}));

function installShell(plugins: Record<string, unknown>, platform: "ios" | "android" = "ios") {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: plugins,
  };
}

describe("native features (chunk 2.3)", () => {
  let api: FakeApi;
  beforeEach(() => {
    api = installFakeApi({ session: readySession() });
  });
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("camera receipts go through the same metadata strip and never the network", async () => {
    let base64 = "";
    for (const b of JPEG) base64 += String.fromCharCode(b);
    const getPhoto = vi.fn(async () => ({ base64String: btoa(base64), format: "jpeg" }));
    installShell({ Camera: { getPhoto } });
    const user = userEvent.setup();
    renderApp("/add?with=receipt");
    const card = await screen.findByRole("region", { name: "Receipt photo" });
    // One button instead of the file input: the OS offers camera or library itself
    expect(within(card).queryByLabelText("Add a receipt photo")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Add a receipt photo" }));
    await waitFor(() => expect(card).toHaveTextContent("Receipt photo attached"));
    expect(getPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ resultType: "base64", source: "PROMPT", saveToGallery: false }),
    );
    const db = openDb("u1");
    const files = await db.files.toArray();
    expect(files).toHaveLength(1);
    // The EXIF segment is gone before anything is stored
    expect(files[0]).toMatchObject({ kind: "receipt", type: "image/jpeg", size: 2 + BODY.length });
    expect(
      api.calls.filter(
        (c) =>
          ![
            "/api/auth/session",
            "/api/groups",
            "/api/notifications/settings",
            "/api/alerts/schedule",
            "/api/billing/entitlements", // Home's trial card reads the plan; no body
          ].includes(c.path),
      ),
    ).toEqual([]);
  });

  it("push registration sends the platform and token only, and unsubscribe releases them", async () => {
    const listeners: Record<string, (data: { value?: string }) => void> = {};
    const token = `apns-${"d".repeat(60)}`;
    installShell({
      PushNotifications: {
        requestPermissions: vi.fn(async () => ({ receive: "granted" })),
        addListener: (event: string, cb: (data: { value?: string }) => void) => {
          listeners[event] = cb;
        },
        register: vi.fn(async () => {
          listeners.registration?.({ value: token });
        }),
      },
    });
    await expect(subscribeToPush()).resolves.toBe("subscribed");
    const posted = api.calls.find(
      (c) => c.method === "POST" && c.path === "/api/notifications/push/native",
    )?.body as Record<string, unknown>;
    expect(posted).toMatchObject({ platform: "ios", token });
    expect(Object.keys(posted).sort()).toEqual(["platform", "token", "user_agent"]);
    await unsubscribeFromPush();
    expect(
      api.calls.find(
        (c) => c.method === "POST" && c.path === "/api/notifications/push/native/unsubscribe",
      )?.body,
    ).toEqual({ platform: "ios", token });
    expect(localStorage.getItem("stackd.push_token")).toBeNull();
  });

  it("push permission refused in the shell reports denied and sends nothing", async () => {
    installShell({
      PushNotifications: {
        requestPermissions: vi.fn(async () => ({ receive: "denied" })),
        addListener: () => {},
        register: vi.fn(),
      },
    });
    await expect(subscribeToPush()).resolves.toBe("denied");
    expect(api.calls.filter((c) => c.path.includes("/push/"))).toEqual([]);
  });

  it("passkey ceremonies run through the StackdPasskeys plugin, never the browser API", async () => {
    const get = vi.fn(async ({ optionsJSON }: { optionsJSON: string }) => {
      expect(JSON.parse(optionsJSON)).toEqual({ challenge: "c2", allowCredentials: [] });
      return {
        credentialJSON: JSON.stringify({
          id: "native-cred",
          rawId: "native-cred",
          type: "public-key",
          response: {},
          clientExtensionResults: {},
        }),
      };
    });
    const create = vi.fn(async ({ optionsJSON }: { optionsJSON: string }) => {
      expect(JSON.parse(optionsJSON)).toMatchObject({ challenge: "c1" });
      return {
        credentialJSON: JSON.stringify({
          id: "new-cred",
          rawId: "new-cred",
          type: "public-key",
          response: {},
          clientExtensionResults: {},
        }),
      };
    });
    installShell({ StackdPasskeys: { get, create } });
    await expect(assertPasskey("unlock")).resolves.toEqual(expect.any(String));
    const passkey = await registerPasskey("iPhone");
    expect(passkey.label).toBe("iPhone passkey");
    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startAuthentication)).not.toHaveBeenCalled();
    expect(vi.mocked(startRegistration)).not.toHaveBeenCalled();
    const sent = api.calls.find((c) => c.path === "/api/security/passkeys/assert/verify")?.body as {
      credential: { id: string };
    };
    expect(sent.credential.id).toBe("native-cred");
  });

  it("Home hands the widget the month's strings; nothing else leaves the device", async () => {
    const setSummary = vi.fn(async () => {});
    installShell({ StackdWidget: { setSummary } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T12:00:00"));
    try {
      const db = openDb("u1");
      await seedDefaults(db);
      const stamp = "2026-10-05T00:00:00Z";
      const base: Omit<Entry, "id" | "amount_cents" | "direction" | "category_id"> = {
        date: "2026-10-05",
        merchant: "Seed",
        clean_description: "SEED",
        raw_description: null,
        account_id: "acct-cash",
        source: "manual",
        receipt_id: null,
        import_id: null,
        is_transfer: false,
        transfer_pair_id: null,
        split_parent_id: null,
        is_recurring: false,
        created_at: stamp,
        updated_at: stamp,
      };
      await db.entries.bulkAdd([
        { ...base, id: "e-in", amount_cents: 150000, direction: "in", category_id: "cat-paycheck" },
        {
          ...base,
          id: "e-out",
          amount_cents: 4217,
          direction: "out",
          category_id: "cat-groceries",
        },
      ]);
      renderApp("/");
      await waitFor(() =>
        expect(setSummary).toHaveBeenCalledWith({
          month: "October",
          got: "$1,500.00",
          spent: "$42.17",
          kept: "$1,457.83",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
