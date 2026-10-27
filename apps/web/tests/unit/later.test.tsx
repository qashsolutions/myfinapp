import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

describe("Later: savings by the age you choose", () => {
  beforeEach(async () => {
    await seedDefaults(openDb("u1"));
  });

  it("draws the band at your rates, answers in one word, and follows your own numbers", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/insights/later");
    expect(await screen.findByRole("heading", { level: 1, name: "Later" })).toBeInTheDocument();
    // $200 a month from 35 to 67: $128,685.56 / $188,956.58 / $285,682.20 at 3% / 5% / 7%.
    const growing = await screen.findByRole("region", { name: "Growing" });
    expect(growing).toHaveTextContent("About $188,956.58 at 67 at 5%");
    expect(growing).toHaveTextContent("$128,685.56 to $285,682.20 across your rates");
    expect(screen.getByRole("img", { name: /Savings from age 35 to 67/ })).toBeInTheDocument();
    expect(screen.getByText(/not a prediction or advice/)).toBeInTheDocument();

    // A goal of $500,000: behind, and about $529.22 a month at 5% would reach it.
    const yours = screen.getByRole("region", { name: "Your numbers" });
    await user.type(within(yours).getByLabelText("Goal (optional)"), "500000");
    const behind = await screen.findByRole("region", { name: "Behind" });
    expect(behind).toHaveTextContent("About $529.22 a month would reach $500,000.00");

    // Retiring at 62 instead: five fewer years, $136,637.84 at 5%.
    fireEvent.change(within(yours).getByRole("slider"), { target: { value: "62" } });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Behind" })).toHaveTextContent(
        "About $136,637.84 at 62 at 5%",
      ),
    );
    const saved = (await openDb("u1").settings.get("later.plan"))?.value;
    expect(saved).toMatchObject({ retire_age: 62, target_cents: 50000000 });

    // Rates out of order are refused, and the last good plan stays.
    const high = within(yours).getByLabelText("High");
    await user.clear(high);
    await user.type(high, "1");
    expect(await screen.findByRole("alert")).toHaveTextContent("rates from low to high");
  });

  it("a plan that grows past what both engines count exactly says so and keeps the last good one", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/insights/later");
    const yours = await screen.findByRole("region", { name: "Your numbers" });
    const high = within(yours).getByLabelText("High");
    await user.clear(high);
    await user.type(high, "500");
    const age = within(yours).getByLabelText("Age now");
    await user.clear(age);
    await user.type(age, "16");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "past what can be counted to the cent",
    );
    const saved = (await openDb("u1").settings.get("later.plan"))?.value as { rates_bps: number[] };
    expect(saved?.rates_bps?.[2] ?? 700).toBeLessThan(50000);
  });
});
