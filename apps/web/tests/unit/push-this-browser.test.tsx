import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { subscribeToPush } from "../../src/pwa/pushSubscribe.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

/** The fake server's key ("BPUBLICKEY") and an older one, as the browser holds them: bytes. */
function keyBytes(value: string): ArrayBuffer {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
}
const SERVER_KEY = "BPUBLICKEY";
const OLD_KEY = "BOLDKEYXYZ";

function fakeSubscription(endpoint: string, key: string | null) {
  return {
    endpoint,
    options: { applicationServerKey: key === null ? null : keyBytes(key) },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

/** A browser with push; `held` is the subscription it already has, if any. */
function fakePushBrowser(held: ReturnType<typeof fakeSubscription> | null) {
  const fresh = fakeSubscription("https://fcm.googleapis.com/fcm/send/new", SERVER_KEY);
  let current = held;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      current = fresh;
      return fresh;
    }),
  };
  for (const sub of [held, fresh]) {
    sub?.unsubscribe.mockImplementation(async () => {
      if (current === sub) current = null;
      return true;
    });
  }
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve({ pushManager }) },
    configurable: true,
  });
  Object.defineProperty(window, "PushManager", {
    value: function PushManager() {},
    configurable: true,
  });
  Object.defineProperty(window, "Notification", {
    value: { permission: "granted", requestPermission: vi.fn(async () => "granted") },
    configurable: true,
  });
  return { pushManager, fresh };
}

function pushCard() {
  return screen.getByRole("region", { name: "Push" });
}

describe("Push on this device (invariant 93)", () => {
  it("on in another browser but not this one: says so and offers Turn on, never a Turn off that does nothing", async () => {
    const api = installFakeApi({ session: readySession() });
    api.notifications.subscribed = true; // the account has push in some other browser
    fakePushBrowser(null); // this browser (a private window) has none
    renderApp("/me/notifications");
    await waitFor(() => expect(pushCard()).toHaveTextContent("Push is off in this browser."));
    expect(pushCard()).toHaveTextContent("It's on in another browser or device.");
    expect(within(pushCard()).getByRole("button", { name: "Turn on notifications" })).toBeEnabled();
    expect(
      within(pushCard()).queryByRole("button", { name: "Turn off on this device" }),
    ).toBeNull();
  });

  it("Turn off ends this browser's own subscription and says so", async () => {
    const user = userEvent.setup();
    const api = installFakeApi({ session: readySession() });
    api.notifications.subscribed = true;
    const held = fakeSubscription("https://fcm.googleapis.com/fcm/send/here", SERVER_KEY);
    fakePushBrowser(held);
    renderApp("/me/notifications");
    await waitFor(() => expect(pushCard()).toHaveTextContent("Push is on for this browser."));
    await user.click(within(pushCard()).getByRole("button", { name: "Turn off on this device" }));
    await waitFor(() => expect(pushCard()).toHaveTextContent("Push is off in this browser."));
    expect(held.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.calls.find((c) => c.path === "/api/notifications/push/unsubscribe")?.body).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/here",
    });
    expect(within(pushCard()).getByRole("status")).toHaveTextContent(
      "Push is off for this browser.",
    );
  });

  it("turning on with a subscription made under an old key replaces it", async () => {
    const api = installFakeApi({ session: readySession() });
    const old = fakeSubscription("https://fcm.googleapis.com/fcm/send/old", OLD_KEY);
    const browser = fakePushBrowser(old);
    expect(await subscribeToPush()).toBe("subscribed");
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    const posts = api.calls.filter(
      (c) => c.method === "POST" && c.path.startsWith("/api/notifications/push"),
    );
    expect(posts.map((c) => [c.path, (c.body as { endpoint: string }).endpoint])).toEqual([
      ["/api/notifications/push/unsubscribe", "https://fcm.googleapis.com/fcm/send/old"],
      ["/api/notifications/push", "https://fcm.googleapis.com/fcm/send/new"],
    ]);
  });

  it("a subscription under the server's key is kept as it is", async () => {
    const api = installFakeApi({ session: readySession() });
    const held = fakeSubscription("https://fcm.googleapis.com/fcm/send/here", SERVER_KEY);
    const browser = fakePushBrowser(held);
    expect(await subscribeToPush()).toBe("subscribed");
    expect(held.unsubscribe).not.toHaveBeenCalled();
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.calls.some((c) => c.path === "/api/notifications/push/unsubscribe")).toBe(false);
  });

  it("after the server's key changes, opening the app renews this browser's push without asking", async () => {
    const api = installFakeApi({ session: readySession() });
    const old = fakeSubscription("https://fcm.googleapis.com/fcm/send/old", OLD_KEY);
    const browser = fakePushBrowser(old);
    renderApp("/");
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.method === "POST" && c.path === "/api/notifications/push"),
      ).toBe(true),
    );
    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(Notification.requestPermission as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(
      api.calls.find((c) => c.method === "POST" && c.path === "/api/notifications/push")?.body,
    ).toMatchObject({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
  });

  it("opening the app touches nothing when push was never on here, or is under the current key", async () => {
    for (const held of [
      null,
      fakeSubscription("https://fcm.googleapis.com/fcm/send/here", SERVER_KEY),
    ]) {
      const api = installFakeApi({ session: readySession() });
      const browser = fakePushBrowser(held);
      const { unmount } = renderApp("/");
      await screen.findByRole("navigation", { name: "Primary" });
      await new Promise((r) => setTimeout(r, 50));
      expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
      // Reading the key to compare is fine; nothing is unsubscribed or registered.
      expect(
        api.calls.some((c) => c.method === "POST" && c.path.startsWith("/api/notifications/push")),
      ).toBe(false);
      unmount();
    }
  });
});
