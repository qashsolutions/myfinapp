import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

describe("Make Qash yours (owner, October 20, 2026: choices, not a wizard)", () => {
  it("lists six optional steps; what's already done shows as done", async () => {
    const db = openDb("u1");
    await seedDefaults(db);
    await db.settings.put({
      key: "pay",
      value: {
        amount_cents: 200000,
        frequency: "biweekly",
        next_payday: null,
        monthly_cents: 433333,
      },
      updated_at: "2026-10-20T00:00:00Z",
    });
    installFakeApi({ session: readySession() });
    renderApp("/setup");
    const list = await screen.findByRole("list", { name: "Things to set up" });
    expect(await within(list).findAllByRole("link")).toHaveLength(6);
    await waitFor(() =>
      expect(within(list).getByRole("link", { name: /Your pay/ })).toHaveTextContent("Done"),
    );
    expect(within(list).getByRole("link", { name: /Add your money/ })).toHaveTextContent(
      "Upload a statement, link a bank, or add as you go",
    );
    expect(screen.getByRole("img", { name: "1 of 6 done" })).toBeInTheDocument();
  });

  it("Done for now hides Home's card for good; nothing is required", async () => {
    const user = userEvent.setup();
    await seedDefaults(openDb("u1"));
    installFakeApi({ session: readySession() });
    renderApp("/");
    expect(
      await screen.findByRole("region", { name: /Make Qash yours · 0 of 6/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "See all, or say you're done" }));
    await user.click(await screen.findByRole("button", { name: "Done for now" }));
    await screen.findByRole("button", { name: "Customize Home" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: /Make Qash yours/ })).toBeNull(),
    );
  });

  it("Arrange your Home opens the card editor straight away", async () => {
    await seedDefaults(openDb("u1"));
    installFakeApi({ session: readySession() });
    renderApp("/?customize=1");
    expect(await screen.findByRole("dialog", { name: "Customize Home" })).toBeInTheDocument();
  });
});
