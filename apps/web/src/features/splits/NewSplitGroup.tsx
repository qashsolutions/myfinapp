import "./splits.css";
import "../auth/auth.css";
import "../groups/groups.css";

import { trimSpaces } from "@stackd/rules/text";
import { Button } from "@stackd/ui";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import type { SplitMethod } from "../../engine/bridge.ts";
import { useSession } from "../auth/useSession.tsx";
import { ChipChoice } from "./ChipChoice.tsx";
import { createSplitGroup, GROUP_KINDS, MAX_NAME, METHODS, splitErrorText } from "./useSplits.ts";
import { NAME_MAX, saveYourName } from "./yourName.ts";

/** New group (canvas "New group"): a name, what it's for and how it usually splits. The key is
 * made on this device; the name travels only inside the encrypted ledger. */
export function NewSplitGroup() {
  const { db } = useDb();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>("home");
  const [method, setMethod] = useState<SplitMethod>("equal");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();
  const needsName = !session.info?.user?.display_name;
  const [yourName, setYourName] = useState("");

  async function create() {
    const clean = trimSpaces(name);
    if (!clean) {
      setError("Give the group a name.");
      return;
    }
    if (clean.length > MAX_NAME) {
      setError(`Keep it to ${MAX_NAME} characters.`);
      return;
    }
    if (needsName) {
      const problem = await saveYourName(yourName);
      if (problem) return setError(problem);
      await session.refresh();
    }
    setBusy(true);
    const r = await createSplitGroup(db, {
      name: clean,
      kind,
      usual_method: method,
      leftover: "payer",
    });
    setBusy(false);
    if (!r.ok) {
      setError(splitErrorText(r.code));
      return;
    }
    navigate(`/splits/${r.group.id}?invite=1`, { replace: true });
  }

  return (
    <>
      <ScreenHeader title="New group" actions={null} back="/goals?tab=splits" />
      <label className="auth__field">
        <span className="auth__label">Group name</span>
        <input
          className="auth__input"
          value={name}
          maxLength={MAX_NAME}
          placeholder="Apartment 4B"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {needsName ? (
        <label className="auth__field">
          <span className="auth__label">Your name, as the group sees it</span>
          <input
            className="auth__input"
            value={yourName}
            maxLength={NAME_MAX}
            autoComplete="name"
            onChange={(e) => setYourName(e.target.value)}
          />
        </label>
      ) : null}
      <ChipChoice
        legend="What's it for?"
        options={GROUP_KINDS}
        value={kind}
        onChange={(v) => setKind(v)}
      />
      <ChipChoice
        legend="Usually split"
        options={METHODS}
        value={method}
        onChange={(v) => setMethod(v)}
      />
      <p className="auth__hint">
        You can change any bill's split. People you invite add bills with this one, and you approve
        them.
      </p>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={create} disabled={busy}>
        Create and invite
      </Button>
    </>
  );
}
