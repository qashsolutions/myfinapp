import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { openDb } from "../../src/data/db.ts";
import { enqueueGroupProgress } from "../../src/data/serverQueue.ts";
import { InstallGuide } from "../../src/features/pwa/InstallGuide.tsx";
import { InstallScreen } from "../../src/features/pwa/InstallScreen.tsx";
import { PullToRefresh } from "../../src/features/pwa/PullToRefresh.tsx";
import { UpdateToast } from "../../src/features/pwa/UpdateToast.tsx";
import {
  DISMISSED_KEY,
  dismissInstall,
  recordVisit,
  shouldOfferInstall,
  VISITS_KEY,
  watchInstallPrompt,
} from "../../src/pwa/install.ts";
import { createUpdateStore, type RegisterOptions, setUpdateStore } from "../../src/pwa/updates.ts";
import { fakeMember, installFakeApi, ME, mayasGroup, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const TODAY = new Date("2026-10-10T12:00:00");

function InstallScreenInRouter() {
  return (
    <MemoryRouter>
      <InstallScreen />
    </MemoryRouter>
  );
}
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CHROME =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

describe("PWA extras", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    localStorage.clear();
    setUserAgent(CHROME);
  });
  afterEach(() => {
    vi.useRealTimers();
    setUpdateStore(null);
  });

  it("offers the install guide after the second visit, not inside the installed app, and not for 14 days after Not now", () => {
    setUserAgent(IPHONE);
    expect(recordVisit()).toBe(1);
    expect(shouldOfferInstall()).toBe(false);
    expect(recordVisit()).toBe(2);
    expect(shouldOfferInstall()).toBe(true);
    dismissInstall();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe(TODAY.toISOString());
    expect(shouldOfferInstall()).toBe(false);
    expect(shouldOfferInstall(new Date("2026-10-23T12:00:00"))).toBe(false);
    expect(shouldOfferInstall(new Date("2026-10-25T12:00:00"))).toBe(true);
    // Installed: never
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    expect(shouldOfferInstall(new Date("2026-10-25T12:00:00"))).toBe(false);
    Object.defineProperty(navigator, "standalone", { value: undefined, configurable: true });
    // Android without the browser's install event: nothing to offer on its own
    setUserAgent(CHROME);
    localStorage.setItem(VISITS_KEY, "5");
    localStorage.removeItem(DISMISSED_KEY);
    expect(shouldOfferInstall()).toBe(false);
  });

  it("iPhone gets the Share steps; Android gets the browser's install dialog", async () => {
    const user = userEvent.setup();
    setUserAgent(IPHONE);
    const onClose = vi.fn();
    const { unmount } = render(<InstallGuide open onClose={onClose} />);
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    expect(steps).toHaveTextContent("Tap Share");
    expect(steps).toHaveTextContent("Tap Add to Home Screen");
    expect(steps).toHaveTextContent("Tap Add");
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem(DISMISSED_KEY)).not.toBeNull();
    unmount();

    setUserAgent(CHROME);
    localStorage.clear();
    watchInstallPrompt();
    const prompt = vi.fn(async () => {});
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt,
      userChoice: Promise.resolve({ outcome: "accepted" as const }),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    const onClose2 = vi.fn();
    render(<InstallGuide open onClose={onClose2} />);
    expect(
      screen.getByText("Tapping Install opens your browser's install dialog."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose2).toHaveBeenCalled());
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it("/install shows picture steps on iPhone Safari, with an arrow at Share", async () => {
    setUserAgent(IPHONE);
    installFakeApi();
    renderApp("/install");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Install Qash" }),
    ).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("strong")?.textContent),
    ).toEqual([
      "Tap Share",
      "Tap Add to Home Screen",
      "Tap Add",
      "Open Qash from your Home Screen",
    ]);
    expect(document.querySelector(".install-pointer")).toHaveTextContent("Share is down here");
  });

  it("/install in an iPhone in-app browser asks for Safari and copies the link", async () => {
    const user = userEvent.setup();
    setUserAgent(`${IPHONE} Instagram 300.0`);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    installFakeApi();
    renderApp("/install");
    const card = await screen.findByRole("region", { name: "Open in Safari" });
    await user.click(within(card).getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://app.qash.solutions/install");
    expect(screen.getByRole("status")).toHaveTextContent("Link copied. Paste it into Safari.");
    expect(screen.queryByRole("list", { name: "Steps" })).toBeNull();
  });

  it("/install on Android installs in one tap when Chrome offers it", async () => {
    const user = userEvent.setup();
    setUserAgent(CHROME);
    watchInstallPrompt();
    const prompt = vi.fn(async () => {});
    act(() => {
      window.dispatchEvent(
        Object.assign(new Event("beforeinstallprompt"), {
          prompt,
          userChoice: Promise.resolve({ outcome: "accepted" as const }),
        }),
      );
    });
    render(<InstallScreenInRouter />);
    await user.click(screen.getByRole("button", { name: "Install Qash" }));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("heading", { level: 1, name: "You're all set" }),
    ).toBeInTheDocument();
  });

  it("shows the offline banner with what is waiting, and syncs when back online", async () => {
    const db = openDb("u1");
    await enqueueGroupProgress(db, "g-maya", 2000);
    const api = installFakeApi({
      session: readySession(),
      groups: [
        { ...mayasGroup(), members: [...mayasGroup().members, fakeMember(ME, "Nia", 1000)] },
      ],
    });
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    renderApp("/insights");
    const title = await screen.findByText("You're offline");
    const banner = title.closest(".offline-banner") as HTMLElement;
    expect(banner).toHaveAttribute("role", "status");
    await waitFor(() =>
      expect(banner).toHaveTextContent(
        "Changes are saved on this device and sync when you're back. 1 waiting.",
      ),
    );
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(async () => expect(await db.server_queue.count()).toBe(0));
    expect(
      api.calls.some((c) => c.method === "PUT" && c.path === "/api/groups/g-maya/progress"),
    ).toBe(true);
    await waitFor(() => expect(screen.queryByText("You're offline")).toBeNull());
  });

  it("the update toast waits for Refresh, then activates the new worker", async () => {
    const user = userEvent.setup();
    let options: RegisterOptions | null = null;
    const update = vi.fn(async () => {});
    const store = createUpdateStore((o) => {
      options = o;
      return update;
    });
    setUpdateStore(store);
    render(<UpdateToast />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => options?.onNeedRefresh?.());
    expect(screen.getByRole("status")).toHaveTextContent("A new version is ready.");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(update).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("asks for a new version whenever the app comes back to the foreground, at most once a minute", async () => {
    let options: RegisterOptions | null = null;
    const registration = { update: vi.fn(async () => {}), waiting: null };
    let clock = 1_000_000;
    const doc = new EventTarget() as unknown as Document;
    Object.defineProperty(doc, "visibilityState", { value: "visible" });
    createUpdateStore(
      (o) => {
        options = o;
        return vi.fn(async () => {});
      },
      { now: () => clock, doc, reload: vi.fn() },
    );
    act(() =>
      options?.onRegisteredSW?.("/sw.js", registration as unknown as ServiceWorkerRegistration),
    );
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).not.toHaveBeenCalled(); // registered a moment ago
    clock += 61_000;
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).toHaveBeenCalledTimes(1);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  it("shows Refresh when the server has a newer build even if no new worker was offered", async () => {
    const user = userEvent.setup();
    let options: RegisterOptions | null = null;
    const update = vi.fn(async () => {});
    const reload = vi.fn();
    const registration = {
      update: vi.fn(async () => {}),
      waiting: null,
      unregister: vi.fn(async () => true),
    };
    const store = createUpdateStore(
      (o) => {
        options = o;
        return update;
      },
      { reload, doc: null, build: "aaaaaaa", fetchBuild: async () => "bbbbbbb" },
    );
    setUpdateStore(store);
    render(<UpdateToast />);
    act(() =>
      options?.onRegisteredSW?.("/sw.js", registration as unknown as ServiceWorkerRegistration),
    );
    expect(await screen.findByText("A new version is ready.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    // No worker waiting: the offline copy starts afresh and the page reloads
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(registration.unregister).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    setUpdateStore(null);
  });

  it("stays quiet when the server's build is the one running", async () => {
    let options: RegisterOptions | null = null;
    const fetchBuild = vi.fn(async () => "aaaaaaa");
    const store = createUpdateStore(
      (o) => {
        options = o;
        return vi.fn(async () => {});
      },
      { doc: null, build: "aaaaaaa", fetchBuild },
    );
    act(() =>
      options?.onRegisteredSW?.("/sw.js", {
        update: vi.fn(async () => {}),
        waiting: null,
      } as unknown as ServiceWorkerRegistration),
    );
    await waitFor(() => expect(fetchBuild).toHaveBeenCalled());
    expect(store.get().needRefresh).toBe(false);
  });

  it("pull to refresh takes a waiting version, otherwise reloads", async () => {
    let options: RegisterOptions | null = null;
    const update = vi.fn(async () => {});
    const reload = vi.fn();
    const registration: { update: () => Promise<void>; waiting: unknown } = {
      update: vi.fn(async () => {}),
      waiting: null,
    };
    const store = createUpdateStore(
      (o) => {
        options = o;
        return update;
      },
      { reload, doc: null },
    );
    act(() =>
      options?.onRegisteredSW?.("/sw.js", registration as unknown as ServiceWorkerRegistration),
    );
    setUpdateStore(store);
    render(<PullToRefresh enabled />);
    const pull = (to: number) => {
      act(() => {
        window.dispatchEvent(
          new TouchEvent("touchstart", { touches: [{ clientY: 100 } as Touch] }),
        );
        window.dispatchEvent(new TouchEvent("touchmove", { touches: [{ clientY: to } as Touch] }));
      });
    };
    pull(160); // 30px after damping: not far enough
    expect(screen.getByRole("status")).toHaveTextContent("Pull to refresh");
    act(() => {
      window.dispatchEvent(new TouchEvent("touchend"));
    });
    expect(reload).not.toHaveBeenCalled();

    pull(300);
    expect(screen.getByRole("status")).toHaveTextContent("Release to refresh");
    act(() => {
      window.dispatchEvent(new TouchEvent("touchend"));
    });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(registration.update).toHaveBeenCalled();
    // A pull while it's still refreshing is ignored on purpose: wait for it to finish.
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());

    registration.waiting = {};
    pull(300);
    act(() => {
      window.dispatchEvent(new TouchEvent("touchend"));
    });
    await waitFor(() => expect(update).toHaveBeenCalledWith(true));
    expect(reload).toHaveBeenCalledTimes(1);
    setUpdateStore(null);
  });

  it("on the signed-out Welcome page a waiting update applies at once (nothing to lose there)", async () => {
    let options: RegisterOptions | null = null;
    const update = vi.fn(async () => {});
    setUpdateStore(
      createUpdateStore((o) => {
        options = o;
        return update;
      }),
    );
    installFakeApi();
    renderApp("/welcome");
    await screen.findByRole("heading", { level: 1 });
    act(() => options?.onNeedRefresh?.());
    await waitFor(() => expect(update).toHaveBeenCalledWith(true));
    setUpdateStore(null);
  });

  it("the sign-in pages offer a waiting update too", async () => {
    let options: RegisterOptions | null = null;
    setUpdateStore(
      createUpdateStore((o) => {
        options = o;
        return vi.fn(async () => {});
      }),
    );
    installFakeApi();
    renderApp("/signin");
    await screen.findByRole("heading", { level: 1 });
    act(() => options?.onNeedRefresh?.());
    expect(await screen.findByText("A new version is ready.")).toBeInTheDocument();
    setUpdateStore(null);
  });

  it("Me has an Install row in a browser tab, not inside the installed app", async () => {
    installFakeApi({ session: readySession() });
    renderApp("/me");
    expect(await screen.findByRole("button", { name: /Install Qash/ })).toBeInTheDocument();
  });
});
