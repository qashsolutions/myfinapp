import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

// The weekly recap stands in for any screen with a bug in it.
vi.mock("../../src/features/recap/WeeklyRecap.tsx", () => ({
  WeeklyRecap: () => {
    throw new Error("a bug");
  },
}));

describe("a screen that throws (October 25, 2026)", () => {
  it("shows a way out instead of a blank page, keeps the tabs, and recovers on another screen", async () => {
    const user = userEvent.setup();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = installFakeApi({ session: readySession() });
    renderApp("/recap");
    const card = await screen.findByRole("region", { name: "Something went wrong" });
    expect(card).toHaveTextContent("Stuck");
    expect(card).toHaveTextContent("Your data is safe on this device");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    // The tab bar still works, and the next screen starts fresh
    const nav = screen.getByRole("navigation", { name: "Primary" });
    await user.click(nav.querySelector('a[href="/budget"]') as HTMLElement);
    expect(await screen.findByRole("heading", { level: 1, name: "Budget" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Something went wrong" })).toBeNull();
    // Nothing about the error was sent anywhere
    expect(JSON.stringify(fake.calls)).not.toMatch(/a bug/);
    quiet.mockRestore();
  });
});
