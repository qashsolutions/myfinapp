/**
 * A fetch-level fake of `/api/splits` (chunk S.2's router) for the split screens. It keeps the
 * server's rules that a screen depends on: who may do what, the daily count, the people limit,
 * pending bills, opaque blobs with forward-only versions and the key handover rows.
 */

export interface FakeSplitMember {
  member_id: string;
  user_id: string | null;
  display_name: string;
  guest: boolean;
  joined_at: string;
}

export interface FakeSplitGroup {
  id: string;
  organizer_user: string | null;
  members: FakeSplitMember[];
  invites: Array<{ id: string; email: string; expires_at: string; token: string }>;
  bills: Array<{ id: string; created_by: string; status: "approved" | "pending" | "declined" }>;
  blobs: Array<{
    member_id: string;
    kind: string;
    ciphertext: string;
    version: number;
    updated_at: string;
  }>;
  keys: Array<{
    member_id: string;
    device_key_id: string;
    public_key: string;
    wrapped_key: string | null;
  }>;
  disputes: Array<{ bill_id: string; member_id: string | null }>;
  guests_can_add: boolean;
  writable: boolean;
  reported: boolean;
  /** Who ran it before (S.6): set when the organizer leaves or someone takes over. */
  previous_organizer_member_id?: string | null;
}

export interface FakeInviteCard {
  token: string;
  group_id: string;
  /** The inbox it was sent to; another signed-in inbox gets 403 other_email. */
  email: string;
  organizer_name: string;
  organizer_email: string;
  member_since: string;
  pays_with_card: boolean;
  /** Who to add on accept (the joining member). */
  member: FakeSplitMember;
}

export interface FakeSplits {
  groups: FakeSplitGroup[];
  /** Invites someone sent to this person (the guest's side). */
  inbox: FakeInviteCard[];
  declined: string[];
  consents: string[];
  left: Array<{ group_id: string; report: string | null }>;
  added_today: number;
  invites_today: number;
  double_check: boolean;
  blocked: boolean;
  reminded: string[];
  seq: number;
  /** The next N ledger or profile writes fail with a 500 (a server or network hiccup). */
  failBlobWrites: number;
  /** Each state read: which group, and how many blob versions the device said it held. */
  stateReads: Array<{ group_id: string; known: number }>;
}

export function emptySplits(): FakeSplits {
  return {
    groups: [],
    inbox: [],
    declined: [],
    consents: [],
    left: [],
    added_today: 0,
    invites_today: 0,
    double_check: false,
    blocked: false,
    reminded: [],
    seq: 0,
    failBlobWrites: 0,
    stateReads: [],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = () => new Response(null, { status: 204 });

export function handleSplits(
  s: FakeSplits,
  method: string,
  path: string,
  b: Record<string, unknown>,
  me: string,
  myName: string,
  limits: Record<string, unknown> | undefined,
  myEmail = "",
): Response | null {
  if (!path.startsWith("/api/splits")) return null;
  const perDay = Number(limits?.split_bills_per_day ?? 0);
  const peopleMax = Number(limits?.split_people_max ?? 0);
  const invitesPerDay = Number(limits?.split_invites_per_day ?? 0);
  const now = new Date().toISOString();
  const today = { added: s.added_today, limit: perDay };
  const out = (g: FakeSplitGroup) => {
    const mine = g.members.find((m) => m.user_id === me);
    return {
      id: g.id,
      is_organizer: g.organizer_user === me,
      my_member_id: mine?.member_id ?? "",
      members: g.members.map((m) => ({
        member_id: m.member_id,
        display_name: m.display_name,
        initial: m.display_name[0]?.toUpperCase() ?? "?",
        is_me: m.user_id === me,
        is_organizer: m.user_id !== null && m.user_id === g.organizer_user,
        guest: m.guest,
        joined_at: m.joined_at,
      })),
      invites:
        g.organizer_user === me
          ? g.invites.map((i) => ({ id: i.id, expires_at: i.expires_at }))
          : [],
      people_max: peopleMax || 6,
      writable: g.writable,
      guests_can_add: g.guests_can_add,
      reported: g.reported,
      previous_organizer_member_id: g.previous_organizer_member_id ?? null,
    };
  };
  const mineGroups = () => s.groups.filter((g) => g.members.some((m) => m.user_id === me));
  if (method === "GET" && path === "/api/splits")
    return json({
      groups: mineGroups().map(out),
      can_create: peopleMax > 0 && !s.blocked,
      guest: peopleMax === 0,
      today,
      double_check: s.double_check,
      blocked: s.blocked,
    });
  if (method === "POST" && path === "/api/splits") {
    if (s.blocked) return json({ detail: "split_blocked" }, 403);
    if (peopleMax === 0) return json({ detail: "plan_required" }, 403);
    s.seq += 1;
    const g: FakeSplitGroup = {
      id: `sg${s.seq}`,
      organizer_user: me,
      members: [
        { member_id: `m-${me}`, user_id: me, display_name: myName, guest: false, joined_at: now },
      ],
      invites: [],
      bills: [],
      blobs: [],
      keys: [],
      disputes: [],
      guests_can_add: true,
      writable: true,
      reported: false,
    };
    s.groups.push(g);
    return json(out(g), 201);
  }
  const invite = path.match(/^\/api\/splits\/invites\/(lookup|accept|decline)$/);
  if (method === "POST" && invite) {
    const card = s.inbox.find((c) => c.token === b.token);
    if (!card || s.declined.includes(card.token)) return json({ detail: "not_found" }, 404);
    if (card.email !== myEmail) return json({ detail: "other_email" }, 403);
    const g = s.groups.find((x) => x.id === card.group_id);
    if (!g) return json({ detail: "not_found" }, 404);
    if (invite[1] === "lookup")
      return json({
        group_id: g.id,
        organizer_name: card.organizer_name,
        organizer_initial: card.organizer_name[0] ?? "?",
        organizer_email: card.organizer_email,
        member_since: card.member_since,
        pays_with_card: card.pays_with_card,
        people: g.members.length,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      });
    s.inbox = s.inbox.filter((c) => c !== card);
    if (invite[1] === "decline") {
      s.declined.push(card.token);
      return empty();
    }
    g.members.push(card.member);
    return json(out(g));
  }
  if (method === "POST" && path === "/api/splits/pay-consent") {
    if (b.version !== "2026-11-08") return json({ detail: "warning_changed" }, 409);
    s.consents.push(JSON.stringify(b));
    return empty();
  }
  const m = path.match(/^\/api\/splits\/([^/]+)(?:\/(.+))?$/);
  if (!m) return json({ detail: "not_found" }, 404);
  const g = s.groups.find((x) => x.id === m[1]);
  const member = g?.members.find((x) => x.user_id === me);
  if (!g || !member) return json({ detail: "not_found" }, 404);
  const rest = m[2] ?? "";
  const organizer = g.organizer_user === me;
  if (method === "POST" && rest === "takeover") {
    // As routers/splits.py takeover: only while nobody can run it, only with a plan.
    if (g.writable) return json({ detail: "organizer_active" }, 409);
    if (peopleMax === 0) return json({ detail: "plan_required" }, 403);
    const was = g.members.find((x) => x.user_id !== null && x.user_id === g.organizer_user);
    if (was) g.previous_organizer_member_id = was.member_id;
    g.organizer_user = me;
    g.writable = true;
    return json(out(g));
  }
  if (method === "PATCH" && rest === "") {
    if (!organizer) return json({ detail: "organizer_only" }, 403);
    g.guests_can_add = Boolean(b.guests_can_add);
    return json(out(g));
  }
  if ((method === "GET" || method === "POST") && rest === "state") {
    // POST sends the versions this device holds; only the others come back (chunk S.5).
    const known = (method === "POST" ? (b.known ?? {}) : {}) as Record<string, number>;
    s.stateReads.push({ group_id: g.id, known: Object.keys(known).length });
    return json({
      blobs: g.blobs.filter((x) => known[`${x.member_id}/${x.kind}`] !== x.version),
      versions: g.blobs.map(({ member_id, kind, version }) => ({ member_id, kind, version })),
      bill_ids: g.bills.filter((x) => x.status === "approved").map((x) => x.id),
      pending: g.bills
        .filter((x) => x.status === "pending")
        .map((x) => ({
          bill_id: x.id,
          member_id: g.members.find((y) => y.user_id === x.created_by)?.member_id ?? null,
        })),
      disputes: g.disputes,
      keys: g.keys.map((k) => (k.member_id === member.member_id ? k : { ...k, wrapped_key: null })),
      writable: g.writable,
    });
  }
  const blob = rest.match(/^blobs\/(ledger|profile|ledger\/[0-9]{4}-(?:0[1-9]|1[0-2]))$/);
  if (method === "PUT" && blob) {
    if (s.failBlobWrites > 0) {
      s.failBlobWrites -= 1;
      return json({ detail: "error" }, 500);
    }
    const kind = (blob[1] as string).replace("ledger/", "ledger:");
    const at = g.blobs.findIndex((x) => x.member_id === member.member_id && x.kind === kind);
    const version = Number(b.version);
    if (at >= 0 && version <= (g.blobs[at]?.version ?? 0))
      return json({ detail: "stale_version" }, 409);
    const row = {
      member_id: member.member_id,
      kind,
      ciphertext: String(b.ciphertext),
      version,
      updated_at: now,
    };
    if (at >= 0) g.blobs[at] = row;
    else g.blobs.push(row);
    return empty();
  }
  if (method === "PUT" && rest === "keys/request") {
    g.keys.push({
      member_id: member.member_id,
      device_key_id: String(b.device_key_id),
      public_key: String(b.public_key),
      wrapped_key: null,
    });
    return empty();
  }
  const wrap = rest.match(/^keys\/([^/]+)\/([^/]+)$/);
  if (method === "PUT" && wrap) {
    const k = g.keys.find((x) => x.member_id === wrap[1] && x.device_key_id === wrap[2]);
    if (k && !k.wrapped_key) k.wrapped_key = String(b.wrapped_key);
    return empty();
  }
  if (method === "POST" && rest === "bills") {
    if (!g.writable) return json({ detail: "read_only" }, 409);
    s.seq += 1;
    const id = `b${s.seq}`;
    if (organizer) {
      if (s.added_today >= perDay) return json({ detail: "daily_limit" }, 429);
      s.added_today += 1;
      g.bills.push({ id, created_by: me, status: "approved" });
      return json({ id, status: "approved", today: { added: s.added_today, limit: perDay } }, 201);
    }
    if (!g.guests_can_add) return json({ detail: "guests_cannot_add" }, 403);
    g.bills.push({ id, created_by: me, status: "pending" });
    return json({ id, status: "pending", today: null }, 201);
  }
  const decide = rest.match(/^bills\/([^/]+)\/(approve|decline)$/);
  if (method === "POST" && decide) {
    if (!organizer) return json({ detail: "organizer_only" }, 403);
    const bill = g.bills.find((x) => x.id === decide[1] && x.status === "pending");
    if (!bill) return json({ detail: "not_found" }, 404);
    if (decide[2] === "decline") {
      bill.status = "declined";
      return empty();
    }
    if (s.added_today >= perDay) return json({ detail: "daily_limit" }, 429);
    s.added_today += 1;
    bill.status = "approved";
    return json({
      id: bill.id,
      status: "approved",
      today: { added: s.added_today, limit: perDay },
    });
  }
  if (method === "POST" && rest === "invites") {
    if (!organizer) return json({ detail: "organizer_only" }, 403);
    if (s.blocked) return json({ detail: "split_blocked" }, 403);
    const email = String(b.email ?? "").toLowerCase();
    if (s.double_check && String(b.email_again ?? "").toLowerCase() !== email)
      return json({ detail: "emails_differ" }, 422);
    if (g.members.length + g.invites.length >= (peopleMax || 6))
      return json({ detail: "plan_limit" }, 403);
    if (s.invites_today >= invitesPerDay) return json({ detail: "invite_limit" }, 429);
    s.invites_today += 1;
    s.seq += 1;
    const invite = {
      id: `i${s.seq}`,
      email,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      token: `tok_${s.seq}_abcdefghijklmnop`,
    };
    g.invites = [...g.invites.filter((x) => x.email !== email), invite];
    return json({ id: invite.id, expires_at: invite.expires_at, token: invite.token }, 201);
  }
  const cancel = rest.match(/^invites\/([^/]+)$/);
  if (method === "DELETE" && cancel) {
    g.invites = g.invites.filter((x) => x.id !== cancel[1]);
    return empty();
  }
  const removal = rest.match(/^members\/([^/]+)$/);
  if (method === "DELETE" && removal) {
    if (!organizer) return json({ detail: "organizer_only" }, 403);
    g.members = g.members.filter((x) => x.member_id !== removal[1]);
    return empty();
  }
  if (method === "POST" && rest === "remind") {
    if (s.blocked) return json({ detail: "split_blocked" }, 403);
    s.reminded.push(String(b.member_id));
    return empty();
  }
  if (method === "POST" && rest === "leave") {
    s.left.push({ group_id: g.id, report: (b.report as string | undefined) ?? null });
    g.members = g.members.filter((x) => x.user_id !== me);
    return empty();
  }
  if (method === "POST" && rest === "disputes") {
    if (!g.disputes.some((d) => d.bill_id === b.bill_id && d.member_id === member.member_id))
      g.disputes.push({ bill_id: String(b.bill_id), member_id: member.member_id });
    return empty();
  }
  const close = rest.match(/^disputes\/([^/]+)\/close$/);
  if (method === "POST" && close) {
    const before = g.disputes.length;
    g.disputes = g.disputes.filter(
      (d) => d.bill_id !== close[1] || (!organizer && d.member_id !== member.member_id),
    );
    return g.disputes.length < before ? empty() : json({ detail: "not_found" }, 404);
  }
  return json({ detail: "not_found" }, 404);
}
