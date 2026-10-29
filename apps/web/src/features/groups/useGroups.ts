import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiFailure,
  api,
  clientFor,
  failureOf,
  type GroupDetail,
  type GroupPreview,
  type GroupSummary,
} from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import type { Goal, StackdDb } from "../../data/db.ts";
import { createGoal } from "../goals/useGoals.ts";
import { type TemplateKey, templateOf } from "./templates.ts";

/**
 * Groups live on the server (name, month, code, members, one percentage each). The member's
 * own target is a local save goal with `group_id`; its deposits never leave the device.
 */

export function useGroups(options: { background?: boolean } = {}): {
  groups: GroupSummary[] | null;
  error: ApiFailure | null;
  refresh: () => Promise<void>;
} {
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const background = options.background ?? false;
  const refresh = useCallback(async () => {
    const r = await clientFor(background).GET("/api/groups");
    const failure = failureOf(r);
    if (failure) {
      setError(failure);
      return;
    }
    setGroups(r.data ?? []);
    setError(null);
  }, [background]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { groups, error, refresh };
}

export function useGroup(id: string | undefined): {
  group: GroupDetail | null;
  error: ApiFailure | null;
  refresh: () => Promise<void>;
  /** Takes a group the server just answered with (a save's response) as the newest. */
  accept: (detail: GroupDetail) => void;
} {
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  // The newest request wins (October 29, 2026): two reads in flight can answer out of order, and
  // an older answer (sent before a save landed) must never replace a newer one.
  const latest = useRef(0);
  const accept = useCallback((detail: GroupDetail) => {
    latest.current += 1;
    setGroup(detail);
    setError(null);
  }, []);
  const refresh = useCallback(async () => {
    if (!id) return;
    const mine = ++latest.current;
    const r = await api.GET("/api/groups/{group_id}", { params: { path: { group_id: id } } });
    if (mine !== latest.current) return;
    const failure = failureOf(r);
    if (failure) {
      setError(failure);
      return;
    }
    setGroup(r.data ?? null);
    setError(null);
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { group, error, refresh, accept };
}

/** The local goal that holds this member's private target for a group. */
export function useGroupGoal(groupId: string | undefined): Goal | null | undefined {
  const { db } = useDb();
  return useLiveQuery<Goal | null>(
    async () =>
      groupId
        ? ((await db.goals
            .where("group_id")
            .equals(groupId)
            .filter((g) => g.status !== "archived")
            .first()) ?? null)
        : null,
    [db, groupId],
  );
}

export async function lookupGroup(code: string): Promise<GroupPreview | ApiFailure> {
  const r = await api.POST("/api/groups/lookup", { body: { code } });
  return failureOf(r) ?? (r.data as GroupPreview);
}

export async function setDisplayName(name: string): Promise<ApiFailure | null> {
  const r = await api.PATCH("/api/account", { body: { display_name: name } });
  return failureOf(r);
}

export interface MemberInput {
  /** Money templates: the member's own target; dining diet: the amount to keep back. */
  targetCents: number | null;
  /** Dining diet: what the member usually spends on dining a month. */
  baselineCents?: number | null;
}

/** Each member's own goal for a challenge, built from its template on this device. */
export async function localGoalFor(
  db: StackdDb,
  group: GroupDetail,
  input: MemberInput,
): Promise<Goal> {
  const existing = await db.goals
    .where("group_id")
    .equals(group.id)
    .filter((g) => g.status !== "archived")
    .first();
  if (existing) return existing;
  const template = templateOf(group.template_key);
  const base = {
    title: group.name,
    category_id: null as string | null,
    start_date: group.start_date,
    end_date: group.end_date,
    baseline_cents: null as number | null,
    group_id: group.id,
    label: null as string | null,
    target_days: null as number | null,
    target_cents: null as number | null,
  };
  if (template.kind === "habit") {
    return createGoal(db, {
      ...base,
      kind: "habit",
      target_days: template.habitDays,
      label: template.habitLabel,
    });
  }
  if (template.kind === "spend_less") {
    const category = (await db.categories.toArray()).find(
      (c) => c.name.toLowerCase() === (template.categoryName ?? "").toLowerCase(),
    );
    return createGoal(db, {
      ...base,
      kind: "spend_less",
      title: template.categoryName ?? group.name,
      label: template.categoryName,
      category_id: category?.id ?? null,
      target_cents: input.targetCents,
      baseline_cents: input.baselineCents ?? null,
    });
  }
  return createGoal(db, {
    ...base,
    kind: "save",
    target_cents: input.targetCents,
    cadence: template.key === "fifty_two_week" ? "weekly" : null,
  });
}

export async function createGroup(
  db: StackdDb,
  input: {
    name: string;
    templateKey: TemplateKey;
    month?: string;
    startDate?: string;
  } & MemberInput,
): Promise<GroupDetail | ApiFailure> {
  const r = await api.POST("/api/groups", {
    body: {
      name: input.name,
      template_key: input.templateKey,
      month: input.month ?? null,
      start_date: input.startDate ?? null,
    },
  });
  const failure = failureOf(r);
  if (failure || !r.data) return failure ?? { status: 500, code: "error" };
  await localGoalFor(db, r.data, input);
  return r.data;
}

export async function joinGroup(
  db: StackdDb,
  input: { code: string } & MemberInput,
): Promise<GroupDetail | ApiFailure> {
  const r = await api.POST("/api/groups/join", { body: { code: input.code } });
  const failure = failureOf(r);
  if (failure || !r.data) return failure ?? { status: 500, code: "error" };
  await localGoalFor(db, r.data, input);
  return r.data;
}

export async function leaveGroup(db: StackdDb, groupId: string): Promise<ApiFailure | null> {
  const r = await api.POST("/api/groups/{group_id}/leave", {
    params: { path: { group_id: groupId } },
  });
  const failure = failureOf(r);
  if (failure) return failure;
  const mine = await db.goals.where("group_id").equals(groupId).toArray();
  const stamp = new Date().toISOString();
  await Promise.all(
    mine.map((g) => db.goals.update(g.id, { status: "archived", updated_at: stamp })),
  );
  return null;
}

export async function removeMember(groupId: string, userId: string): Promise<ApiFailure | null> {
  const r = await api.DELETE("/api/groups/{group_id}/members/{user_id}", {
    params: { path: { group_id: groupId, user_id: userId } },
  });
  return failureOf(r);
}

export async function regenerateCode(groupId: string): Promise<GroupDetail | ApiFailure> {
  const r = await api.POST("/api/groups/{group_id}/code", {
    params: { path: { group_id: groupId } },
  });
  return failureOf(r) ?? (r.data as GroupDetail);
}

export function isFailure(value: unknown): value is ApiFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}
