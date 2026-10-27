import "./onboarding.css";

import { Button, List } from "@stackd/ui";
import { Link, useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { APP_NAME } from "../../lib/brand.ts";
import { finishSetup, useSetup } from "./useSetup.ts";

/**
 * /setup, "Make Qash yours": six things worth doing, each optional, in any order. Shown right
 * after the trial is picked and from Home's card until the person is done; nothing is forced,
 * nothing is counted or sent anywhere.
 */
export function SetupHub() {
  const setup = useSetup();
  const { db } = useDb();
  const navigate = useNavigate();
  const done = setup ? setup.steps.length - setup.left : 0;
  return (
    <>
      <ScreenHeader title={`Make ${APP_NAME} yours`} actions={null} />
      <p className="setup-hub__lead">
        Pick any, in any order. Skip what you don't need; you can come back anytime.
      </p>
      <div
        className="setup-hub__progress"
        role="img"
        aria-label={`${done} of ${setup?.steps.length ?? 6} done`}
      >
        {(setup?.steps ?? []).map((s) => (
          <span key={s.id} className={`setup-hub__dot${s.done ? " setup-hub__dot--done" : ""}`} />
        ))}
      </div>
      <List card aria-label="Things to set up">
        {(setup?.steps ?? []).map((s, i) => (
          <li className="sk-list__item" key={s.id}>
            <Link className="sk-row sk-row--interactive setup-hub__row" to={s.to}>
              <span
                className={`setup-hub__mark${s.done ? " setup-hub__mark--done" : ""}`}
                aria-hidden="true"
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className="sk-row__text">
                <span className="sk-row__label">{s.title}</span>
                <span className="sk-row__sublabel">{s.done ? "Done" : s.line}</span>
              </span>
            </Link>
          </li>
        ))}
      </List>
      <Button
        block
        onClick={async () => {
          await finishSetup(db);
          navigate("/", { replace: true });
        }}
      >
        {setup && setup.left === 0 ? "All set. Go to Home" : "Done for now"}
      </Button>
    </>
  );
}
