import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { openDb, seedDefaults } from "../../src/data/db.ts";
import { installFakeApi, readySession } from "../fakeApi.ts";
import { renderApp } from "../render.tsx";

// Each keystroke checks its plan through the engine; here an earlier, shorter amount answers
// later than the full one, as a busy worker can.
vi.mock("../../src/engine/bridge.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/engine/bridge.ts")>();
  return {
    ...real,
    growthProjection: async (plan: { target_cents: number }) => {
      const digits = String(plan.target_cents).length;
      await new Promise((r) => setTimeout(r, Math.max(0, 120 - digits * 15)));
      return real.growthProjection(plan as never);
    },
  };
});

describe("Later saves what was typed last", () => {
  beforeEach(async () => {
    await seedDefaults(openDb("u1"));
  });

  it("an older keystroke answering late never overwrites the newer one", async () => {
    const user = userEvent.setup();
    installFakeApi({ session: readySession() });
    renderApp("/insights/later");
    const yours = await screen.findByRole("region", { name: "Your numbers" });
    await user.type(within(yours).getByLabelText("Goal (optional)"), "500000");
    await new Promise((r) => setTimeout(r, 400)); // every keystroke's check has answered
    await waitFor(async () =>
      expect((await openDb("u1").settings.get("later.plan"))?.value).toMatchObject({
        target_cents: 50000000,
      }),
    );
  });
});
