import "./splits.css";
import "../auth/auth.css";

import { trimSpaces } from "@stackd/rules/text";
import { Button } from "@stackd/ui";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { useSession } from "../auth/useSession.tsx";
import { createSplitGroup, MAX_NAME, sendInvite, splitErrorText, useSplits } from "./useSplits.ts";
import { NAME_MAX, saveYourName } from "./yourName.ts";

/**
 * Split with one person (chunk S.9, November 10, 2026): no group to name. A group of two is made
 * behind the scenes ("You and Sam"), the friend is invited by email the same way, and Add a bill
 * opens straight away (from an entry too, with `?entry=`). Every rule of a group applies.
 */
export function NewOneSplit() {
  const { db } = useDb();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const entry = params.get("entry");
  const { splits } = useSplits();
  const session = useSession();
  const needsName = !session.info?.user?.display_name;
  const [yourName, setYourName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doubleCheck = splits?.double_check ?? false;

  async function start() {
    const clean = trimSpaces(name);
    if (!clean) return setError("Who are you splitting with?");
    if (clean.length > MAX_NAME) return setError(`Keep it to ${MAX_NAME} characters.`);
    if (!email.trim()) return setError("Their email, so they can join.");
    if (doubleCheck && email.trim().toLowerCase() !== again.trim().toLowerCase())
      return setError(splitErrorText("emails_differ"));
    if (needsName) {
      const problem = await saveYourName(yourName);
      if (problem) return setError(problem);
      await session.refresh();
    }
    setBusy(true);
    const made = await createSplitGroup(db, {
      name: clean,
      kind: "one",
      usual_method: "equal",
      leftover: "payer",
    });
    if (!made.ok) {
      setBusy(false);
      return setError(splitErrorText(made.code));
    }
    const sent = await sendInvite(made.group.id, email.trim(), doubleCheck ? again.trim() : null);
    setBusy(false);
    if (!sent.ok) {
      // The group of two exists; the invite can be sent again from it.
      navigate(`/splits/${made.group.id}?invite=1`, { replace: true });
      return;
    }
    const suffix = entry ? `?entry=${encodeURIComponent(entry)}` : "";
    navigate(`/splits/${made.group.id}/bills/new${suffix}`, { replace: true });
  }

  return (
    <>
      <ScreenHeader title="Split with one person" actions={null} back="/splits" />
      <label className="auth__field">
        <span className="auth__label">Their name</span>
        <input
          className="auth__input"
          value={name}
          maxLength={MAX_NAME}
          placeholder="Sam"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="auth__field">
        <span className="auth__label">Their email</span>
        <input
          className="auth__input"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {doubleCheck ? (
        <label className="auth__field">
          <span className="auth__label">Their email again</span>
          <input
            className="auth__input"
            type="email"
            autoComplete="off"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </label>
      ) : null}
      {needsName ? (
        <label className="auth__field">
          <span className="auth__label">Your name, as they'll see it</span>
          <input
            className="auth__input"
            value={yourName}
            maxLength={NAME_MAX}
            autoComplete="name"
            onChange={(e) => setYourName(e.target.value)}
          />
        </label>
      ) : null}
      <p className="auth__hint">
        We email them an invite; they join free. You add the bill now, and it counts once they're
        in.
      </p>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={start} disabled={busy}>
        Invite and add a bill
      </Button>
    </>
  );
}
