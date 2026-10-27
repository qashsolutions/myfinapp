import { render, screen } from "@testing-library/react";
import { BalanceRunway } from "../../src/features/insights/InsightCard.tsx";

const day = (date: string, balance_cents: number) => ({ date, balance_cents });

describe("the balance chart on Safe to spend and Next 30 days (October 19, 2026)", () => {
  it("labels today, the lowest point with its date, the cushion and both ends", () => {
    render(
      <BalanceRunway
        days={[day("2026-10-19", 110_00), day("2026-10-25", 40_00), day("2026-10-30", 90_00)]}
        cushionCents={50_00}
        endLabel="Payday Oct 31"
      />,
    );
    const chart = screen.getByRole("img");
    expect(chart).toHaveAccessibleName(
      "Estimated balance: $110.00 today, lowest $40.00 on Oct 25, cushion $50.00",
    );
    expect(screen.getByText("$110.00")).toBeInTheDocument();
    expect(screen.getByText(/Low \$40\.00 · Oct 25/)).toHaveClass("runway__label--short");
    expect(screen.getByText("Cushion $50.00")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Payday Oct 31")).toBeInTheDocument();
  });

  it("a low point above the cushion is not marked short", () => {
    render(
      <BalanceRunway
        days={[day("2026-10-19", 300_00), day("2026-10-20", 200_00)]}
        cushionCents={50_00}
        endLabel="Oct 20"
      />,
    );
    expect(screen.getByText(/Low \$200\.00/)).not.toHaveClass("runway__label--short");
  });

  it("draws nothing with fewer than two days", () => {
    const { container } = render(
      <BalanceRunway days={[day("2026-10-19", 1)]} cushionCents={0} endLabel="Oct 19" />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });
});
