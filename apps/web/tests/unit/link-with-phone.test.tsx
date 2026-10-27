import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { linkUrl, qrPath } from "../../src/features/auth/linkQr.ts";
import { installFakeApi } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";

function asDevice(userAgent: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

describe("Link with your phone, the computer's screen (B2, October 19, 2026)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is offered on a computer's Sign in and Welcome, never on a phone", async () => {
    asDevice(MAC);
    installFakeApi();
    const first = renderApp("/signin");
    expect(await screen.findByRole("link", { name: "Sign in with your phone" })).toHaveAttribute(
      "href",
      "/signin/phone",
    );
    first.unmount();
    const second = renderApp("/welcome");
    expect(
      await screen.findByRole("link", { name: "Sign in with your phone" }),
    ).toBeInTheDocument();
    second.unmount();

    asDevice(IPHONE);
    renderApp("/signin");
    await screen.findByLabelText("Email address");
    expect(screen.queryByRole("link", { name: "Sign in with your phone" })).toBeNull();
  });

  it("shows a QR code and the letters, waits, and signs in once the phone approves", async () => {
    asDevice(MAC);
    const api = installFakeApi();
    renderApp("/signin/phone");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in with your phone" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("ABCD-EFG1")).toBeInTheDocument();
    expect(
      await screen.findByRole("img", { name: "QR code to scan with your phone" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for your phone…");
    expect(screen.getByText(/Expires in [12]:\d\d/)).toBeInTheDocument();

    // The phone approves (B3); the next check picks up the session and the app opens.
    act(() => {
      if (api.deviceLink) api.deviceLink.status = "approved";
    });
    expect(
      await screen.findByRole("navigation", { name: "Primary" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path === "/api/auth/link/start")).toHaveLength(1);
    expect(api.calls.some((c) => c.path === "/api/auth/link/status")).toBe(true);
  });

  it("says so when the phone says no, and a new code can be asked for", async () => {
    const user = userEvent.setup();
    asDevice(MAC);
    const api = installFakeApi();
    renderApp("/signin/phone");
    await screen.findByText("ABCD-EFG1");
    act(() => {
      if (api.deviceLink) api.deviceLink.status = "denied";
    });
    expect(
      await screen.findByText("Your phone said no", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    expect(await screen.findByText("ABCD-EFG2")).toBeInTheDocument();
  });

  it("an expired code offers a new one; past 3 an hour it says to wait or use email", async () => {
    const user = userEvent.setup();
    asDevice(MAC);
    const api = installFakeApi({ deviceLinkStarts: 2 });
    renderApp("/signin/phone");
    await screen.findByText("ABCD-EFG3");
    act(() => {
      if (api.deviceLink) api.deviceLink.status = "expired";
    });
    expect(await screen.findByText("That code expired", {}, { timeout: 5000 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    expect(await screen.findByText("That's 3 codes this hour")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Use email instead" })).toHaveAttribute(
      "href",
      "/signin",
    );
  });
});

describe("the link QR code", () => {
  it("points at the phone's approval screen with the code, letters only", () => {
    expect(linkUrl("abcd-efgh", "https://app.qash.solutions")).toBe(
      "https://app.qash.solutions/link?code=ABCDEFGH",
    );
  });

  it("draws a square grid with a quiet zone", async () => {
    const qr = await qrPath("https://app.qash.solutions/link?code=ABCDEFGH");
    expect(qr.size).toBeGreaterThanOrEqual(25);
    expect(qr.d.startsWith("M2 2h1v1h-1z")).toBe(true); // the finder pattern's corner
  });
});
