import "./household.css";
import "../auth/auth.css";

import { Button, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { api, failureOf, failureText } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { useSession } from "../auth/useSession.tsx";
import { loadEntitlements } from "../billing/entitlements.ts";
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
  const [preview, setPreview] = useState<{
    invited_by: string;
    initial: string;
    you_pay?: { label: string; source: "stripe" | "apple" | "google" } | null;
  } | null>(null);
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

  async function join(stopMine = false) {
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
    // The partner's plan now covers this account too (invariant 54): ask the server again so
    // the app opens to it at once, trial clock and card ask gone.
    if (info?.user?.id) await loadEntitlements(info.user.id, true);
    // "Stop mine": the Plan screen opens "If you cancel" for their own plan (owner decision,
    // October 29, 2026); nothing stops until they tick and tap there.
    navigate(stopMine ? "/me/plan?stop=1" : "/me/household", { replace: true });
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
            One price covers both of you: {preview.invited_by}'s plan becomes yours too, with no
            trial or card of your own. If it ends, it ends for both of you, with an email first.
          </p>
          <p className="auth__hint">
            You'll each keep your own private data. Jars you choose to share show who added what.
            {info?.user?.display_name ? "" : " Set your name in Me first so your partner sees it."}
          </p>
          {preview.you_pay ? (
            <div className="join-own-plan">
              <p>
                <strong>
                  You pay for {preview.you_pay.label} yourself. In a household one plan covers you
                  both. Stop yours at the end of its paid period?
                </strong>
              </p>
              {preview.you_pay.source === "stripe" ? null : (
                <p className="auth__hint">
                  {preview.you_pay.source === "apple"
                    ? "You bought it in the App Store, so you stop it there."
                    : "You bought it in Google Play, so you stop it there."}
                </p>
              )}
              <Button
                block
                onClick={() => void join(true)}
                disabled={busy || !key || local?.householdId !== null}
              >
                Stop mine
              </Button>
              <Button
                block
                variant="secondary"
                onClick={() => void join()}
                disabled={busy || !key || local?.householdId !== null}
              >
                Keep mine
              </Button>
            </div>
          ) : (
            <Button
              block
              onClick={() => void join()}
              disabled={busy || !key || local?.householdId !== null}
            >
              Join {preview.invited_by}'s household
            </Button>
          )}
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
