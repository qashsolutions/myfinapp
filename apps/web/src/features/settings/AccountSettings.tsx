import "../auth/auth.css";

import { Button, List, ListRow, Sheet } from "@stackd/ui";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { api, failureOf, failureText } from "../../data/api.ts";
import { useSession } from "../auth/useSession.tsx";
import { usePlanLine } from "./SettingsScreen.tsx";

/** Me → Account & plan: your plan, the name group members see, and your email. */
export function AccountSettings() {
  const session = useSession();
  const navigate = useNavigate();
  const plan = usePlanLine();
  const [editName, setEditName] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const go = (path: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(path);
  };
  const email = session.info?.user?.email ?? "";
  const displayName = session.info?.user?.display_name ?? null;

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Enter a name.");
      return;
    }
    const r = await api.PATCH("/api/account", { body: { display_name: trimmed } });
    const failure = failureOf(r);
    if (failure) {
      setNameError(failureText(failure, "Couldn't save your name. Try again."));
      return;
    }
    await session.refresh();
    setEditName(false);
  }

  return (
    <>
      <ScreenHeader title="Account & plan" actions={null} back="/me" />
      <section aria-labelledby="plan-h">
        <h2 className="section-title" id="plan-h">
          Plan
        </h2>
        <List card>
          <ListRow
            label={plan.title}
            sublabel={plan.detail}
            href="/me/plan"
            onClick={go("/me/plan")}
          />
        </List>
      </section>
      <section aria-labelledby="profile-h">
        <h2 className="section-title" id="profile-h">
          Profile
        </h2>
        <List card>
          <ListRow
            id="set-name"
            label="Your name"
            sublabel={displayName ?? "Not set · what group members see"}
            value="Edit"
            onClick={() => {
              setName(displayName ?? "");
              setNameError(null);
              setEditName(true);
            }}
          />
          <ListRow label="Email" sublabel={email} href="/me/email" onClick={go("/me/email")} />
        </List>
      </section>
      <Sheet open={editName} onClose={() => setEditName(false)} title="Your name">
        <p className="auth__hint">What other group members see. Your email stays private.</p>
        <label className="auth__field">
          <span className="auth__label">Name</span>
          <input
            className="auth__input"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {nameError ? (
          <p className="auth__error" role="alert">
            {nameError}
          </p>
        ) : null}
        <Button block onClick={saveName}>
          Save
        </Button>
      </Sheet>
    </>
  );
}
