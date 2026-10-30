import "./household.css";
import "../auth/auth.css";
import "../groups/groups.css";

import { Button, Card, Chip, List, ListRow, Sheet, Toggle } from "@stackd/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { api, failureOf } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { type CombinedTotals, combineTotals, splitContributions } from "../../engine/bridge.ts";
import { formatCents, formatDate, formatMonth, todayIso } from "../../lib/format.ts";
import { useSession } from "../auth/useSession.tsx";
import { loadEntitlements, useEntitlements } from "../billing/entitlements.ts";
import { PlanLimit } from "../billing/PlanLimit.tsx";
import { ensureHouseholdKey, inviteLink, myMonthSummary } from "./householdSync.ts";
import {
  createInvite,
  isFailure,
  leaveHousehold,
  setShareSummary,
  useHouseholdCloseSync,
  useHouseholdLocal,
  useHouseholdStatus,
} from "./useHousehold.ts";

/**
 * Me → Couples & household (docs/spec.md "Couples & household"; no mockup, built from the spec):
 * invite one partner with a link that carries the household key (never our server), the two
 * members, the shared jars with who added what, the optional combined In / Out, and leaving.
 */
export function HouseholdScreen() {
  const { db } = useDb();
  const { info } = useSession();
  const navigate = useNavigate();
  const userId = info?.user?.id ?? "";
  const { entitlements } = useEntitlements();
  useHouseholdCloseSync(true); // the shared jars are on screen: pull every 15 s
  const { status, error, refresh } = useHouseholdStatus();
  const local = useHouseholdLocal();
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  // What each of the two keeps if the household splits now, from the server's one rule
  // (invariant 67); null until it answers, then the general line stands in.
  const [outcomes, setOutcomes] = useState<LeaveOutcome[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [together, setTogether] = useState<CombinedTotals | null>(null);
  const [splits, setSplits] = useState<Record<string, Array<{ member_id: string; cents: number }>>>(
    {},
  );
  const today = todayIso();

  const household = status?.household ?? null;
  const partner = household?.members.find((m) => !m.is_me) ?? null;
  const shared = useLiveQuery(
    async () =>
      household
        ? db.goals
            .where("household_id")
            .equals(household.id)
            .filter((g) => g.status !== "archived")
            .toArray()
        : [],
    [db, household?.id],
  );
  const sharedEvents = useLiveQuery(async () => {
    const ids = new Set((shared ?? []).map((g) => g.id));
    return (await db.goal_events.toArray()).filter((e) => ids.has(e.goal_id));
  }, [db, shared]);

  // A pending invite (one member) shows its link again: same code, same key.
  useEffect(() => {
    if (!household?.invite || link) return;
    let alive = true;
    void ensureHouseholdKey(db).then((key) => {
      if (alive && household.invite) setLink(inviteLink(household.invite.code, key));
    });
    return () => {
      alive = false;
    };
  }, [db, household, link]);

  useEffect(() => {
    if (!household || !shared || !sharedEvents) return;
    let alive = true;
    void (async () => {
      const members = household.members.map((m) => m.user_id);
      const next: typeof splits = {};
      for (const g of shared) {
        const events = sharedEvents
          .filter((e) => e.goal_id === g.id)
          .map((e) => ({
            member_id: e.member_id ?? userId,
            type: e.type,
            amount_cents: e.amount_cents,
          }))
          .filter((e) => members.includes(e.member_id));
        next[g.id] = (await splitContributions(events, members)).contributions;
      }
      if (alive) setSplits(next);
    })().catch(() => null);
    return () => {
      alive = false;
    };
  }, [household, shared, sharedEvents, userId]);

  useEffect(() => {
    if (!local?.shareSummary || !local.partnerSummary || !household) {
      setTogether(null);
      return;
    }
    let alive = true;
    void (async () => {
      const mine = await myMonthSummary(db, userId, today);
      const theirs = local.partnerSummary;
      if (!theirs || theirs.month !== mine.month) {
        if (alive) setTogether(null);
        return;
      }
      const result = await combineTotals([
        { member_id: userId, in_cents: mine.in_cents, out_cents: mine.out_cents },
        { member_id: theirs.member_id, in_cents: theirs.in_cents, out_cents: theirs.out_cents },
      ]);
      if (alive) setTogether(result);
    })().catch(() => null);
    return () => {
      alive = false;
    };
  }, [db, userId, today, local?.shareSummary, local?.partnerSummary, household]);

  async function invite() {
    setNote(null);
    setBusy(true);
    const result = await createInvite(db);
    setBusy(false);
    if (isFailure(result)) {
      setNote(
        result.code === "plan_required"
          ? "Couples & household needs Connected."
          : result.code === "household_full"
            ? "Your household already has two people."
            : result.status === 0
              ? "You're offline. Try again when connected."
              : "Couldn't make an invite. Try again.",
      );
      return;
    }
    setLink(result.link);
    await refresh();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNote("Link copied. Send it to your partner privately: the key in it never reaches us.");
    } catch {
      setNote("Couldn't copy. The link is above.");
    }
  }

  async function openLeave() {
    setOutcomes(null);
    setConfirmLeave(true);
    const r = await api.GET("/api/household/leave/preview");
    if (!failureOf(r) && r.data) setOutcomes(r.data as LeaveOutcome[]);
  }

  async function leave() {
    setConfirmLeave(false);
    setBusy(true);
    const failure = await leaveHousehold(db, userId);
    setBusy(false);
    if (failure) {
      setNote(
        failure.status === 0
          ? "You're offline. Try again when connected."
          : "Couldn't leave. Try again.",
      );
      return;
    }
    setLink(null);
    setNote("You left the household. Your shared jars kept your own deposits.");
    await refresh();
    // The shared plan no longer covers whoever it covered (invariant 54): ask again.
    if (userId) await loadEntitlements(userId, true);
  }

  const nameOf = (id: string) =>
    id === userId
      ? "You"
      : (household?.members.find((m) => m.user_id === id)?.display_name ?? "Partner");

  // A partner on any plan sees the household they are in; starting one needs Connected.
  if (!entitlements.household && status && !household) {
    return (
      <>
        <ScreenHeader title="Couples & household" actions={null} back="/me/groups" />
        <PlanLimit>
          Part of Connected. Invite one partner, share the jars you choose, see your month together.
          Your own data stays private.
        </PlanLimit>
      </>
    );
  }

  return (
    <>
      <ScreenHeader title="Couples & household" actions={null} back="/me/groups" />
      {error ? (
        <Card>
          <p>Couldn't reach the server. Try again when online.</p>
        </Card>
      ) : null}
      {status && !household ? (
        <Card as="section" aria-label="Invite your partner">
          <h2 className="sk-card__title">Invite your partner</h2>
          <p>
            One price covers both of you: your plan becomes your partner's too, with no trial or
            card of their own. If it ends, it ends for both of you, and we email you both first.
          </p>
          <p>
            A household is the two of you. Shared jars and goals are encrypted with a key made on
            this device and passed in the invite link, never to our server. Everything else stays
            private to each of you.
          </p>
          <Button block onClick={invite} disabled={busy}>
            Make an invite link
          </Button>
        </Card>
      ) : null}
      {household ? (
        <section aria-labelledby="members-h">
          <h2 className="section-title" id="members-h">
            Household
          </h2>
          <List card>
            {household.members.map((m) => (
              <ListRow
                key={m.user_id}
                leading={
                  <span className="avatar" aria-hidden="true">
                    {m.initial}
                  </span>
                }
                label={m.is_me ? `${m.display_name} (you)` : m.display_name}
                sublabel={m.user_id === household.owner_id ? "Started the household" : "Partner"}
              />
            ))}
          </List>
        </section>
      ) : null}
      {household && household.members.length < 2 ? (
        <Card as="section" aria-label="Waiting for your partner">
          <p>
            <strong>Waiting for your partner.</strong> Send them this link privately. It works for 7
            days and carries the household key, which never reaches us.
          </p>
          {link ? (
            <>
              <p className="household-link">
                <span className="sr-only">Invite link: </span>
                {link}
              </p>
              <Button block variant="secondary" onClick={() => copy(link)}>
                Copy link
              </Button>
            </>
          ) : (
            <Button block onClick={invite} disabled={busy}>
              Make an invite link
            </Button>
          )}
        </Card>
      ) : null}
      {household && partner ? (
        <>
          <Card as="section" aria-label="Month together">
            <Toggle
              checked={local?.shareSummary ?? false}
              onChange={(on) => void setShareSummary(db, userId, on)}
              label="Share my month totals"
              description={`${partner.display_name} sees your In and Out for the month, never an entry. Both must share to see the month together.`}
            />
            {together ? (
              <div className="together" style={{ marginTop: 12 }}>
                <div>
                  <div className="together__label">In</div>
                  <div className="together__value">{formatCents(together.in_cents)}</div>
                </div>
                <div>
                  <div className="together__label">Out</div>
                  <div className="together__value">{formatCents(together.out_cents)}</div>
                </div>
                <div>
                  <div className="together__label">Kept</div>
                  <div className="together__value">{formatCents(together.net_cents)}</div>
                </div>
              </div>
            ) : local?.shareSummary ? (
              <p className="sk-card__eyebrow" style={{ marginTop: 8 }}>
                {formatMonth(today)} together appears once {partner.display_name} shares too.
              </p>
            ) : null}
          </Card>
          <section aria-labelledby="shared-h">
            <h2 className="section-title" id="shared-h">
              Shared jars
            </h2>
            {shared && shared.length === 0 ? (
              <Card>
                <p>
                  No shared jars yet. When you make a jar, switch on "Share with{" "}
                  {partner.display_name}".{" "}
                  <Link to="/goals/new" className="auth__link">
                    New jar
                  </Link>
                </p>
              </Card>
            ) : null}
            {(shared ?? []).map((g) => (
              <Card as="article" key={g.id} aria-label={g.title}>
                <div className="goal-card__top">
                  <span className="goal-card__title">{g.title}</span>
                  <Chip tone="accent">Shared</Chip>
                </div>
                <p className="group-row__meta">
                  {(splits[g.id] ?? [])
                    .map((c) => `${nameOf(c.member_id)} ${formatCents(c.cents)}`)
                    .join(" · ")}
                  {g.target_cents ? ` · of ${formatCents(g.target_cents)}` : ""}
                </p>
                <Button variant="ghost" size="sm" onClick={() => navigate(`/goals/${g.id}`)}>
                  Open
                </Button>
              </Card>
            ))}
          </section>
        </>
      ) : null}
      {household ? (
        <Button variant="ghost" block onClick={() => void openLeave()} disabled={busy}>
          <span style={{ color: "var(--c-danger)" }}>Leave household</span>
        </Button>
      ) : null}
      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}
      <p className="auth__fineprint">
        Your partner sees only the jars you share and, if you turn it on, your month totals.
      </p>
      <Sheet
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Leave the household?"
      >
        <ul className="auth__hint" style={{ paddingLeft: 20 }}>
          <li>Each of you keeps a copy of every shared jar, holding your own deposits.</li>
          <li>Your partner's deposits leave this device; yours leave theirs.</li>
          <li>Month totals stop being shared.</li>
          {outcomes ? outcomes.map((o) => <li key={o.user_id}>{outcomeLine(o)}</li>) : null}
        </ul>
        <Button block onClick={() => setConfirmLeave(false)}>
          Stay
        </Button>
        <Button block variant="ghost" onClick={leave}>
          <span style={{ color: "var(--c-danger)" }}>Leave household</span>
        </Button>
      </Sheet>
    </>
  );
}

type LeaveOutcome = {
  user_id: string;
  name: string;
  is_me: boolean;
  outcome: "keeps" | "own_plan" | "seven_days" | "same_end" | "paused" | "unchanged";
  plan: "private" | "connected" | "founding" | null;
  until: string | null;
};

const PLAN_LABELS = { private: "Private", connected: "Connected", founding: "Founding" } as const;

/** One line per person, in plain words, for what the server says they keep. */
export function outcomeLine(o: LeaveOutcome): string {
  const plan = o.plan ? PLAN_LABELS[o.plan] : "";
  const until = o.until ? formatDate(o.until) : "";
  switch (o.outcome) {
    case "keeps":
      return o.is_me ? `You keep ${plan}.` : `${o.name} keeps ${plan}.`;
    case "own_plan":
      return o.is_me
        ? `You go back to your own ${plan}.`
        : `${o.name} goes back to their own ${plan}.`;
    case "seven_days":
      return o.is_me
        ? `You have 7 days, until ${until}, to pick a plan or download your data.`
        : `${o.name} has 7 days, until ${until}, to pick a plan or download their data.`;
    case "same_end":
      return o.is_me
        ? `Your plan already ended: you keep the same date, ${until}.`
        : `${o.name}'s plan already ended: they keep the same date, ${until}.`;
    case "paused":
      return o.is_me
        ? "Your plan stays paused until its payment is settled, then you have 7 days."
        : `${o.name}'s plan stays paused until its payment is settled, then they have 7 days.`;
    default:
      return o.is_me
        ? "Your own plan carries on as it is."
        : `${o.name}'s own plan carries on as it is.`;
  }
}
