import "../auth/auth.css";
import "./settings.css";

import { Button, Card, List, ListRow } from "@stackd/ui";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useSession } from "../auth/useSession.tsx";
import { useEntitlements } from "../billing/entitlements.ts";
import { AppVersion } from "./SettingsScreen.tsx";

/**
 * A split-bill guest's Me (spec "Guests"): How friends pay me, My groups, Payments I confirmed,
 * Alerts, Log out, Delete account, and one quiet line offering the trial.
 */
export function GuestMe() {
  const session = useSession();
  const navigate = useNavigate();
  const { entitlements } = useEntitlements();
  const access = entitlements.access;
  const email = session.info?.user?.email ?? "";
  const go = (path: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(path);
  };
  const tryPath = access?.state === "choose" && !access.trial_used ? "/start" : "/me/plan";
  return (
    <>
      <ScreenHeader title="Me" actions={null} />
      <List card aria-label="You">
        <ListRow label={email} sublabel="Guest in split groups · free" />
      </List>
      <List card aria-label="Split bills">
        <ListRow
          label="How friends pay me"
          sublabel="Your Venmo, Cash App or PayPal"
          href="/me/split-pay"
          onClick={go("/me/split-pay")}
        />
        <ListRow label="My groups" href="/splits" onClick={go("/splits")} />
        <ListRow
          label="Payments I confirmed"
          href="/me/split-payments"
          onClick={go("/me/split-payments")}
        />
        <ListRow label="Alerts" href="/me/notifications" onClick={go("/me/notifications")} />
        <ListRow label="Download my data" href="/me/data" onClick={go("/me/data")} />
      </List>
      <p className="auth__fineprint">
        To leave or report a group, open it and tap Leave or report.
      </p>
      <Card as="section" aria-label="Account">
        <Button
          variant="secondary"
          block
          onClick={async () => {
            await session.signOut();
            navigate("/welcome", { replace: true });
          }}
        >
          Log out
        </Button>
        <Button variant="ghost" block onClick={() => navigate("/me/delete")}>
          <span style={{ color: "var(--c-danger)" }}>Delete account</span>
        </Button>
      </Card>
      <p className="auth__fineprint">
        <a href={tryPath} onClick={go(tryPath)}>
          Budgets, goals and your own groups · Try 3 days free
        </a>
      </p>
      <AppVersion />
    </>
  );
}
