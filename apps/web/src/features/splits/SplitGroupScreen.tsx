import "./splits.css";
import "../auth/auth.css";

import { Button, buttonClass, Card, Chip, List, ListRow, Toggle } from "@stackd/ui";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { Word } from "../../app/layout/Word.tsx";
import { useDb } from "../../data/DbProvider.tsx";
import { dayOf, formatCents, formatDay } from "../../lib/format.ts";
import { BillSheet } from "./BillSheet.tsx";
import { CheckFirstSheet } from "./CheckFirstSheet.tsx";
import { GroupHistorySheet } from "./GroupHistorySheet.tsx";
import { GroupSettingsSheet } from "./GroupSettingsSheet.tsx";
import { InviteSheet } from "./InviteSheet.tsx";
import { LeaveSheet } from "./LeaveSheet.tsx";
import { groupTitle, type ShownBill } from "./ledger.ts";
import { RemoveSheet } from "./RemoveSheet.tsx";
import { type Payment, SettleSheet } from "./SettleSheet.tsx";
import { balanceText } from "./SplitsTab.tsx";
import { SpottedCard } from "./SpottedCard.tsx";
import {
  authorityOf,
  cancelInvite,
  decideBill,
  namesOf,
  notifyMember,
  recordPayment,
  remind,
  type SplitMemberOut,
  setGuestsCanAdd,
  splitErrorText,
  takeOver,
  useSplitGroup,
} from "./useSplits.ts";

const REPEAT_WORD = { weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" } as const;

/**
 * One split group (canvas "The group"): my balance in one word, the fewest payments that settle
 * everyone, bills waiting for the organizer's OK, payments to confirm, the bills, the people and
 * (for the organizer) invites and the group's switch for guests' bills.
 */
export function SplitGroupScreen() {
  const { id } = useParams();
  const { db } = useDb();
  const [params, setParams] = useSearchParams();
  const { splits, group, view, error, refresh } = useSplitGroup(id);
  const [inviting, setInviting] = useState(false);
  const [settle, setSettle] = useState<Payment | null>(null);
  const [removing, setRemoving] = useState<SplitMemberOut | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [paying, setPaying] = useState<Payment | null>(null);
  const [openBill, setOpenBill] = useState<ShownBill | null>(null);
  const [leaving, setLeaving] = useState<"leave" | "report" | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (params.get("invite") === "1" && group?.is_organizer) {
      setInviting(true);
      setParams({}, { replace: true });
    }
  }, [params, group, setParams]);

  if (error?.status === 404) {
    return (
      <>
        <ScreenHeader title="Group" actions={null} back="/goals?tab=splits" />
        <Card>
          <p>You're not in this group any more.</p>
        </Card>
      </>
    );
  }
  if (!group || !view || !splits) {
    return (
      <>
        <ScreenHeader title="Group" actions={null} back="/goals?tab=splits" />
        {error ? (
          <Card>
            <p>Couldn't reach the server. Try again when you're online.</p>
          </Card>
        ) : (
          <p className="sr-only" role="status">
            Loading
          </p>
        )}
      </>
    );
  }

  const nameOf = namesOf(group);
  const me = group.my_member_id;
  const organizerName = group.members.find((m) => m.is_organizer)?.display_name ?? "the organizer";
  const title = groupTitle(view.merged.group) ?? "Group";
  const mine = view.balances.find((b) => b.person === me)?.cents ?? 0;
  const word = mine > 0 ? "Owed" : mine < 0 ? "Owe" : "Clear";
  const atLimit =
    group.is_organizer && splits.today.limit > 0 && splits.today.added >= splits.today.limit;
  const canAdd = group.writable && !splits.blocked && (group.is_organizer || group.guests_can_add);
  const pending = view.merged.bills.filter((b) => b.status === "pending");
  const approved = view.merged.bills.filter((b) => b.status === "approved");
  const claimsForMe = view.merged.claims.filter((c) => c.to === me);
  const myClaims = view.merged.claims.filter((c) => c.from === me);
  const balanceOf = (memberId: string) =>
    view.balances.find((b) => b.person === memberId)?.cents ?? 0;

  async function act(run: () => Promise<{ ok: boolean; code?: string }>, done: string) {
    const r = await run();
    setNote(r.ok ? done : splitErrorText((r as { code: string }).code));
    await refresh();
  }

  const header = (
    <ScreenHeader
      title={title}
      back="/goals?tab=splits"
      actions={
        group.is_organizer && group.writable && !splits.blocked ? (
          <Button size="sm" variant="secondary" onClick={() => setInviting(true)}>
            Invite
          </Button>
        ) : null
      }
    />
  );

  if (!view.hasKey) {
    return (
      <>
        {header}
        <Card role="status">
          <Word>Waiting</Word>
          <p>
            This device needs the group's key from {organizerName}'s device or another member's. It
            arrives the next time one of them opens Qash.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      {group.reported ? (
        <Card role="alert">
          <Word>Reported</Word>
          <p>Reported. Don't pay unless you're sure.</p>
        </Card>
      ) : null}
      {!group.writable ? (
        <Card role="status">
          <p>
            {group.members.some((m) => m.is_organizer)
              ? `View and settle only: ${organizerName}'s plan has ended.`
              : "View and settle only: nobody runs this group now."}
          </p>
          {/* Run this group (S.6): anyone in it with a plan of their own. */}
          {!group.is_organizer && splits.can_create && !splits.blocked ? (
            <Button
              block
              onClick={() => {
                const prev = authorityOf(group);
                void act(
                  () =>
                    takeOver(
                      db,
                      group,
                      prev && view.authority ? { memberId: prev, ledger: view.authority } : null,
                    ),
                  "You run this group now.",
                );
              }}
            >
              Run this group
            </Button>
          ) : null}
        </Card>
      ) : null}
      <Card tone="accent" as="section" aria-label="Your balance">
        <span className="sk-card__eyebrow">
          {group.members.length} {group.members.length === 1 ? "person" : "people"}
          {group.is_organizer ? " · You run it" : ` · Run by ${organizerName}`}
        </span>
        <Word>{word}</Word>
        {mine === 0 ? (
          <p>Everyone's settled up.</p>
        ) : (
          <p className="sk-card__hero">
            {formatCents(Math.abs(mine))}
            {mine === 0 ? null : (
              <span className="sk-card__hero-unit">{mine > 0 ? " owed to you" : " you owe"}</span>
            )}
          </p>
        )}
        {view.onHold.length > 0 ? (
          <p>
            {view.onHold.length} disputed {view.onHold.length === 1 ? "bill is" : "bills are"} on
            hold.
          </p>
        ) : null}
      </Card>
      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}

      <SpottedCard group={group} view={view} onChanged={refresh} />
      {view.payments.length > 0 ? (
        <Card as="section" aria-labelledby="split-settle-h">
          <h2 className="sk-card__title" id="split-settle-h">
            Settle up
          </h2>
          {view.payments.map((p) => {
            const text = `${nameOf(p.from)} ${p.from === me ? "pay" : "pays"} ${
              p.to === me ? "you" : nameOf(p.to)
            } ${formatCents(p.cents)}`;
            const mayMark = p.from === me || p.to === me || group.is_organizer;
            const handles = view.profiles.get(p.to)?.handles ?? {};
            const mayPay = p.from === me && Object.values(handles).some(Boolean);
            const mayRemind =
              p.from !== me &&
              (p.to === me || group.is_organizer) &&
              !splits.blocked &&
              group.members.some((m) => m.member_id === p.from);
            return (
              <div className="split-pay" key={`${p.from}-${p.to}`}>
                <span className="split-pay__text">{text}</span>
                <span className="split-pay__actions">
                  {mayRemind ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act(() => remind(group.id, p.from), `Reminder sent to ${nameOf(p.from)}.`)
                      }
                    >
                      Remind
                    </Button>
                  ) : null}
                  {mayMark ? (
                    <Button size="sm" variant="ghost" onClick={() => setSettle(p)}>
                      Mark paid
                    </Button>
                  ) : null}
                  {mayPay ? (
                    <Button size="sm" variant="secondary" onClick={() => setPaying(p)}>
                      Pay
                    </Button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </Card>
      ) : null}

      {claimsForMe.length > 0 ? (
        <Card as="section" aria-labelledby="split-claims-h">
          <h2 className="sk-card__title" id="split-claims-h">
            Did they pay you?
          </h2>
          {claimsForMe.map((c) => (
            <div className="split-pay" key={c.id}>
              <span className="split-pay__text">
                {nameOf(c.from)} says they paid you {formatCents(c.cents)} on {formatDay(c.date)}
              </span>
              <span className="split-pay__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    act(async () => {
                      const r = await recordPayment(db, group, {
                        from: c.from,
                        to: c.to,
                        cents: c.cents,
                        via: c.via,
                        confirms: c.id,
                      });
                      if (r.ok) void notifyMember(group.id, "confirmed", c.from); // S.10
                      return r;
                    }, "Confirmed. It's settled for everyone.")
                  }
                >
                  Confirm
                </Button>
              </span>
            </div>
          ))}
        </Card>
      ) : null}
      {myClaims.map((c) => (
        <p className="auth__hint" key={c.id}>
          Waiting for {nameOf(c.to)} to confirm your {formatCents(c.cents)}.
        </p>
      ))}

      {pending.length > 0 ? (
        <Card as="section" aria-labelledby="split-pending-h">
          <h2 className="sk-card__title" id="split-pending-h">
            {group.is_organizer ? "Waiting for your OK" : `Waiting for ${organizerName}`}
          </h2>
          {pending.map((b) => (
            <div className="split-pay" key={b.id}>
              <span className="split-pay__text">
                {b.what} · {formatCents(b.amount_cents)} · added by {nameOf(b.added_by)}
              </span>
              {group.is_organizer ? (
                <span className="split-pay__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => act(() => decideBill(db, group, b, "decline"), "Declined.")}
                  >
                    Decline
                  </Button>
                  <Link
                    to={`/splits/${group.id}/bills/${b.base_id}`}
                    className={buttonClass({ size: "sm", variant: "ghost" })}
                  >
                    Edit
                  </Link>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={atLimit}
                    onClick={() => act(() => decideBill(db, group, b, "approve"), "Approved.")}
                  >
                    Approve
                  </Button>
                </span>
              ) : null}
            </div>
          ))}
          {atLimit ? (
            <p className="auth__hint">Done for today. Approve more tomorrow at midnight.</p>
          ) : null}
        </Card>
      ) : null}

      {splits.double_check && group.is_organizer ? (
        <Card role="status">
          <Word>Double-check</Word>
          <p>
            3 recent invites or bills came back as mistakes. Type emails twice and check each bill's
            amount and people. This goes away after 30 days with no new one.
          </p>
        </Card>
      ) : null}

      {atLimit ? (
        <Card role="status">
          <Word>Done</Word>
          <p>
            Done for today · {splits.today.added} of {splits.today.limit} bills added. More tomorrow
            at midnight.
          </p>
        </Card>
      ) : canAdd ? (
        <Link to={`/splits/${group.id}/bills/new`} className={buttonClass({ block: true })}>
          Add a bill
        </Link>
      ) : group.writable && !group.is_organizer ? (
        <p className="auth__hint">{organizerName} adds the bills in this group.</p>
      ) : null}

      <h2 className="section-title">Bills</h2>
      {approved.length === 0 ? (
        <Card>
          <p>No bills yet.</p>
        </Card>
      ) : (
        <List card aria-label="Bills">
          {approved.map((b) => (
            <ListRow
              key={b.id}
              onClick={() => setOpenBill(b)}
              chevron
              label={
                <>
                  {b.what}
                  {b.disputed ? <Chip tone="warning"> On hold</Chip> : null}
                  {b.repeat ? <Chip> {REPEAT_WORD[b.repeat]}</Chip> : null}
                </>
              }
              sublabel={`${formatDay(b.date)} · ${nameOf(b.paid_by)} paid${b.edited ? " · Edited" : ""}`}
              value={formatCents(b.amount_cents)}
            />
          ))}
        </List>
      )}

      <h2 className="section-title">People</h2>
      <List card aria-label="People">
        {group.members.map((m) => {
          const cents = balanceOf(m.member_id);
          return (
            <ListRow
              key={m.member_id}
              label={`${m.is_me ? "You" : m.display_name}${m.is_organizer ? " · runs it" : ""}`}
              sublabel={m.guest ? "Guest" : undefined}
              value={balanceText(cents)}
              valueTone={cents > 0 ? "success" : cents < 0 ? "danger" : "sub"}
              onClick={
                group.is_organizer && !m.is_me && group.writable ? () => setRemoving(m) : undefined
              }
            />
          );
        })}
      </List>
      {group.is_organizer && group.members.length > 1 ? (
        <p className="auth__fineprint">Tap someone to remove them.</p>
      ) : null}

      {group.is_organizer && group.invites.length > 0 ? (
        <Card as="section" aria-labelledby="split-invites-h">
          <h2 className="sk-card__title" id="split-invites-h">
            Invites waiting
          </h2>
          {group.invites.map((i) => (
            <div className="split-pay" key={i.id}>
              <span className="split-pay__text">Expires {formatDay(dayOf(i.expires_at))}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => act(() => cancelInvite(group.id, i.id), "Invite cancelled.")}
              >
                Cancel
              </Button>
            </div>
          ))}
        </Card>
      ) : null}

      {group.is_organizer ? (
        <Card as="section" aria-label="Group settings">
          {group.writable ? (
            <Button block variant="secondary" onClick={() => setSettingUp(true)}>
              Name, usual split and more
            </Button>
          ) : null}
          <Toggle
            checked={group.guests_can_add}
            label="Guests can add bills"
            description="Their bills wait for your OK before they count."
            onChange={(on) =>
              act(
                () => setGuestsCanAdd(group.id, on),
                on ? "Guests can add bills." : "Only you add bills now.",
              )
            }
          />
        </Card>
      ) : null}

      <Button block variant="secondary" onClick={() => setShowHistory(true)}>
        History
      </Button>
      <p className="auth__fineprint">
        Qash never moves money. Pay each other your usual way, then mark it paid.
      </p>
      {group.is_organizer ? null : (
        <Button block variant="ghost" onClick={() => setLeaving("leave")}>
          <span style={{ color: "var(--c-danger)" }}>Leave or report</span>
        </Button>
      )}
      <GroupHistorySheet
        group={group}
        view={view}
        open={showHistory}
        onClose={() => setShowHistory(false)}
        onChanged={refresh}
      />
      <GroupSettingsSheet
        group={group}
        meta={view.merged.group}
        open={settingUp}
        onClose={() => setSettingUp(false)}
        onSaved={refresh}
      />
      <BillSheet
        group={group}
        view={view}
        bill={openBill}
        onClose={() => setOpenBill(null)}
        onChanged={refresh}
      />
      <CheckFirstSheet
        key={paying ? `${paying.from}>${paying.to}` : "none"}
        group={group}
        payment={paying}
        toName={paying ? nameOf(paying.to) : ""}
        profile={paying ? (view.profiles.get(paying.to) ?? null) : null}
        reported={
          group.reported &&
          paying !== null &&
          group.members.some((m) => m.is_organizer && m.member_id === paying.to)
        }
        onClose={() => setPaying(null)}
        onReport={() => {
          setPaying(null);
          setLeaving("report");
        }}
        onPaid={refresh}
      />
      <LeaveSheet
        key={leaving ?? "closed"}
        groupId={group.id}
        organizerName={organizerName}
        balance={mine}
        open={leaving !== null}
        startWithReport={leaving === "report"}
        onClose={() => setLeaving(null)}
      />

      <InviteSheet
        group={group}
        doubleCheck={splits.double_check}
        open={inviting}
        onClose={() => setInviting(false)}
        onSent={() => void refresh()}
      />
      <SettleSheet
        group={group}
        payment={settle}
        onClose={() => setSettle(null)}
        onSaved={refresh}
      />
      <RemoveSheet
        group={group}
        view={view}
        member={removing}
        onClose={() => setRemoving(null)}
        onDone={refresh}
      />
    </>
  );
}
