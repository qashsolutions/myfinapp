import "../goals/goals.css";

import { Button, Card } from "@stackd/ui";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { formatCents, todayIso } from "../../lib/format.ts";
import { createGoal, useGoalProgress, useGoals } from "../goals/useGoals.ts";
import { isEmergencyJar } from "../home/useHome.ts";
import { EmergencySection } from "./EmergencySection.tsx";

/**
 * The standalone emergency-fund screen (fast-follow 1; mockup F5Emergency): the same runway,
 * target, milestones and plan as inside the jar, reachable from Home's card without opening
 * the jar first. The money still lives in the "Emergency fund" jar.
 */
export function EmergencyScreen() {
  const { db } = useDb();
  const navigate = useNavigate();
  const today = todayIso();
  const goals = useGoals();
  const jar = goals?.find((g) => isEmergencyJar(g) && g.status !== "archived") ?? null;
  const view = useGoalProgress(jar, today);
  const saved = view?.progress?.current ?? 0;

  async function createJar() {
    const goal = await createGoal(db, {
      kind: "save",
      title: "Emergency fund",
      target_cents: 100000, // the $1,000 starter fund; raise it to a month of essentials later
      target_days: null,
      label: null,
      category_id: null,
      start_date: today,
      end_date: null,
      baseline_cents: null,
      group_id: null,
    });
    navigate(`/goals/${goal.id}`);
  }

  return (
    <>
      <ScreenHeader title="Emergency fund" actions={null} back="/" />
      {goals && !jar ? (
        <Card as="section" aria-label="Start the fund">
          <p>
            Your emergency fund is a jar named "Emergency fund". Start it with the $1,000 starter
            target; the runway and milestones below follow what you set aside.
          </p>
          <Button block onClick={createJar}>
            Create the Emergency fund jar
          </Button>
        </Card>
      ) : null}
      {jar ? (
        <>
          <EmergencySection savedCents={saved} />
          <Card as="section" aria-label="The jar">
            <p>
              {formatCents(saved)} set aside so far
              {jar.target_cents ? ` of the jar's ${formatCents(jar.target_cents)} target` : ""}.
            </p>
            <Button block variant="secondary" onClick={() => navigate(`/goals/${jar.id}`)}>
              Open the jar to log a deposit
            </Button>
          </Card>
        </>
      ) : null}
      <p className="auth__fineprint">Runway and milestones are arithmetic on your own numbers.</p>
    </>
  );
}
