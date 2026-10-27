import { Card } from "@stackd/ui";
import type { ReactNode } from "react";
import { Link } from "react-router";

/** A plan cap in the way (docs/spec.md: downgrading never deletes; over-limit items go read-only). */
export function PlanLimit({ children }: { children: ReactNode }) {
  return (
    <Card as="div" aria-label="Plan limit" role="status">
      <p>{children}</p>
      <p>
        <Link to="/me/plan" className="auth__link">
          See plans
        </Link>
      </p>
    </Card>
  );
}
