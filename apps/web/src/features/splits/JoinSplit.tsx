import "./splits.css";
import "../auth/auth.css";

import type { components } from "@stackd/api-client";
import { Button, Card } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { api, failureOf, failureText } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { formatMonth } from "../../lib/format.ts";
import { useSession } from "../auth/useSession.tsx";
import { useEntitlements } from "../billing/entitlements.ts";
import { rememberGroupKey } from "./splitSync.ts";
import { splitErrorText } from "./useSplits.ts";
import { NAME_MAX, saveYourName } from "./yourName.ts";

type InviteCard = components["schemas"]["InviteCardOut"];

/**
 * The invite card (spec "The invite card"): who is asking, their masked email, since when they've
 * been on Qash, whether they pay for it with a US card, and how many are in the group. Nobody is
 * added without a yes. "I don't know <name>" is a mistake for them and stops them asking again.
 * The token goes to the server; the group's key in `#k=` (an in-person QR code) stays here.
 */
export function JoinSplit() {
  const { db } = useDb();
  const navigate = useNavigate();
  const { refresh } = useEntitlements();
  const { hash, pathname } = useLocation();
  // The invite link's fragment, read once, then taken out of the address bar and history.
  const [{ token, key }] = useState(() => {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    return { token: params.get("t") ?? "", key: params.get("k") ?? "" };
  });
  useEffect(() => {
    if (hash) navigate(pathname, { replace: true });
  }, [hash, pathname, navigate]);
  const [card, setCard] = useState<InviteCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const session = useSession();
  const needsName = !session.info?.user?.display_name;
  const [yourName, setYourName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError("This link is missing its invite. Open it again from the email.");
      return;
    }
    let alive = true;
    void api.POST("/api/splits/invites/lookup", { body: { token } }).then((r) => {
      if (!alive) return;
      const failure = failureOf(r);
      if (failure || !r.data) {
        setError(
          failure ? failureText(failure, splitErrorText(failure.code)) : splitErrorText("failed"),
        );
        return;
      }
      setCard(r.data);
    });
    return () => {
      alive = false;
    };
  }, [token]);

  async function join() {
    if (needsName) {
      const problem = await saveYourName(yourName);
      if (problem) return setNameError(problem);
      await session.refresh();
    }
    setBusy(true);
    const r = await api.POST("/api/splits/invites/accept", { body: { token } });
    const failure = failureOf(r);
    if (failure || !r.data) {
      setBusy(false);
      return setError(failure ? failureText(failure, splitErrorText(failure.code)) : "");
    }
    if (key) {
      try {
        await rememberGroupKey(db, r.data.id, key);
      } catch {
        // a damaged key in the link: the device asks a member's device for it instead
      }
    }
    await refresh(); // a new guest's app becomes Splits and Me
    navigate(`/splits/${r.data.id}`, { replace: true });
  }

  async function decline() {
    setBusy(true);
    const r = await api.POST("/api/splits/invites/decline", { body: { token } });
    setBusy(false);
    const failure = failureOf(r);
    if (failure) return setError(failureText(failure, splitErrorText(failure.code)));
    setDeclined(true);
  }

  const name = card?.organizer_name ?? "";
  return (
    <>
      <ScreenHeader title="Split bills invite" actions={null} />
      {declined ? (
        <Card role="status">
          <p>Thanks for telling us. {name} can't invite this email again.</p>
        </Card>
      ) : error ? (
        <Card role="alert">
          <p>{error}</p>
        </Card>
      ) : !card ? (
        <p className="sr-only" role="status">
          Loading
        </p>
      ) : (
        <>
          <Card as="section" aria-label="Who's inviting you">
            <span className="avatar" aria-hidden="true">
              {card.organizer_initial}
            </span>
            <h2 className="sk-card__title">{name} invited you to split bills</h2>
            <ul className="sk-list" aria-label="About them">
              <li>{card.organizer_email}</li>
              <li>On Qash since {formatMonth(`${card.member_since}-01`)}</li>
              {card.pays_with_card ? <li>Pays for Qash with a US card</li> : null}
              <li>
                {card.people} {card.people === 1 ? "person" : "people"} in the group
              </li>
            </ul>
          </Card>
          <p className="auth__hint">
            Joining is free. Qash never moves money and never asks for your bank or card.
          </p>
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
          {nameError ? (
            <p className="auth__error" role="alert">
              {nameError}
            </p>
          ) : null}
          <Button block onClick={join} disabled={busy}>
            I know {name} · Join
          </Button>
          <Button block variant="ghost" onClick={decline} disabled={busy}>
            I don't know {name}
          </Button>
        </>
      )}
    </>
  );
}
