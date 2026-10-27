import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseLockMinutes } from "../../src/features/security/AutoLockSetting.tsx";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

describe("auto-lock choice (owner decision, October 12, 2026)", () => {
  it("accepts only whole minutes from 5 to 60", () => {
    expect(parseLockMinutes("5")).toBe(5);
    expect(parseLockMinutes(" 60 ")).toBe(60);
    for (const bad of ["4", "61", "0", "", "12.5", "ten", "-5", "100"])
      expect(parseLockMinutes(bad)).toBeNull();
  });

  it("type a number or drag the slider; Save asks for the passkey and the server keeps it", async () => {
    const api = installFakeApi({ session: readySession() });
    const user = userEvent.setup();
    renderApp("/me/security");
    await screen.findByRole("textbox", { name: /Minutes, from 5 to 60/ });
    // Let the screen finish loading (its lists and the plan) before typing: on a slow CI machine
    // the section could mount again after the first find, and a value typed into the first copy
    // was lost (October 19, 2026). Then take the box and slider as they are now.
    await waitFor(() => {
      const paths = new Set(api.calls.map((c) => c.path));
      for (const p of ["/api/security/passkeys", "/api/security/devices", "/api/security/activity"])
        expect(paths.has(p)).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 50));
    const box = screen.getByRole("textbox", { name: /Minutes, from 5 to 60/ });
    const slider = screen.getByRole("slider", { name: "Lock after, in minutes" });
    expect(box).toHaveValue("5");
    expect(slider).toHaveValue("5");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(); // nothing changed yet

    // Values are set directly: simulated clear-then-type raced the screen's loading on slow CI
    // machines (the box held "57" after "clear, type 75"), which is not what this test is about.
    fireEvent.change(box, { target: { value: "75" } });
    expect(await screen.findByText("Pick a whole number from 5 to 60.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.change(box, { target: { value: "3a0" } }); // letters never get in
    expect(box).toHaveValue("30");
    expect(slider).toHaveValue("30");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. Locks after 30 minutes without activity.")).toBeTruthy();
    const put = api.calls.find((c) => c.path === "/api/security/lock");
    expect(put?.body).toEqual({ minutes: 30 });
    // The session is read again, so the app's own timer uses the new window at once.
    const putAt = api.calls.findIndex((c) => c.path === "/api/security/lock");
    await waitFor(() =>
      expect(api.calls.slice(putAt).some((c) => c.path === "/api/auth/session")).toBe(true),
    );
    expect(box).toHaveValue("30");
  });
});
