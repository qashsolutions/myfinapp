import "./household.css";
import "../auth/auth.css";

import { Button, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { api, failureOf, failureText } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { useSession } from "../auth/useSession.tsx";
import { isFailure, joinHousehold, useHouseholdLocal } from "./useHousehold.ts";

/**
 * /household/join?code=HH-XXXXXX#k=<key>: the partner's side of the invite. The code goes to
 * the server to look up who is inviting; the key after `#` is read here and never sent.
 */
export function JoinHousehold() {
  const { db } = useDb();
  const { info } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const local = useHouseholdLocal();
  const code = (params.get("code") ?? "").trim().toUpperCase();
  const key = new URLSearchParams(hash.replace(/^#/, "")).get("k") ?? "";
  const [preview, setPreview] = useState<{ invited_by: string; initial: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    if (!code) return;
    void api.POST("/api/household/lookup", { body: { code } }).then((r) => {
      if (!alive) return;
      const failure = failureOf(r);
      if (failure || !r.data)
        setError(
          failure?.status === 404
            ? "This invite link no longer works. Ask your partner for a new one."
            : failureText(
                failure ?? { status: 500, code: "error" },
                "Couldn't check that invite. Try again.",
              ),
        );
      else setPreview(r.data);
    });
    return () => {
      alive = false;
    };
  }, [code]);

  async function join() {
    setError(null);
    setBusy(true);
    const result = await joinHousehold(db, code, key);
    setBusy(false);
    if (isFailure(result)) {
      setError(
        result.code === "already_in_household"
          ? "You're already in a household. Leave it first from Me → Couples & household."
          : result.code === "household_full"
            ? "That household already has two people."
            : result.code === "plan_required"
              ? "Your partner's plan no longer includes couples & household."
              : result.status === 404
                ? "This invite link no longer works. Ask your partner for a new one."
                : failureText(result, "Couldn't join. Try again."),
      );
      return;
    }
    navigate("/me/household", { replace: true });
  }

  return (
    <>
      <ScreenHeader title="Join a household" actions={null} back="/me" />
      {!key ? (
        <Card>
          <p>
            This link is missing its key. Open the exact link your partner sent; the part after "#"
            is the household key, and it only ever lives in the link and on your devices.
          </p>
        </Card>
      ) : null}
      {preview ? (
        <Card as="section" aria-label="Invitation">
          <p>
            <span className="avatar" aria-hidden="true" style={{ marginRight: 8 }}>
              {preview.initial}
            </span>
            <strong>{preview.invited_by}</strong> invited you to share a household.
          </p>
          <p className="auth__hint">
            You'll each keep your own private data. Jars you choose to share show who added what.
            {info?.user?.display_name ? "" : " Set your name in Me first so your partner sees it."}
          </p>
          <Button block onClick={join} disabled={busy || !key || local?.householdId !== null}>
            Join {preview.invited_by}'s household
          </Button>
        </Card>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
