import { useLiveQuery } from "dexie-react-hooks";
import { useDb } from "../../data/DbProvider.tsx";
import type { StackdDb } from "../../data/db.ts";

/**
 * A screen's cards in the person's own order, some switched off (Home since October 19, 2026;
 * every main screen since October 25, 2026: "the premise of everything we show"). Kept in
 * `settings` `<screen>.layout` and synced with the backup like other settings.
 */
export type CardSpec<Id extends string = string> = readonly [id: Id, title: string, line: string];

export interface CardLayout<Id extends string = string> {
  order: Id[];
  hidden: Id[];
  /** False for the moment the saved layout is being read, so a screen never flashes the default. */
  ready?: boolean;
}

/** A saved layout made whole: unknown ids dropped, cards added since it was saved appended. */
export function normalizeCards<Id extends string>(
  raw: unknown,
  defaults: readonly Id[],
): CardLayout<Id> {
  const known = new Set<string>(defaults);
  const value = (raw ?? {}) as { order?: unknown; hidden?: unknown };
  const order = (Array.isArray(value.order) ? value.order : []).filter(
    (id, i, all): id is Id => known.has(id as string) && all.indexOf(id) === i,
  );
  for (const id of defaults) if (!order.includes(id)) order.push(id);
  const hidden = (Array.isArray(value.hidden) ? value.hidden : []).filter(
    (id, i, all): id is Id => known.has(id as string) && all.indexOf(id) === i,
  );
  return { order, hidden };
}

export function layoutKey(screen: string): string {
  return `${screen}.layout`;
}

export function useCardLayout<Id extends string>(
  screen: string,
  cards: readonly CardSpec<Id>[],
): CardLayout<Id> {
  const { db } = useDb();
  // null: nothing saved; undefined: still reading.
  const row = useLiveQuery(async () => (await db.settings.get(layoutKey(screen))) ?? null, [db]);
  return {
    ...normalizeCards(
      row?.value,
      cards.map(([id]) => id),
    ),
    ready: row !== undefined,
  };
}

export async function saveCardLayout<Id extends string>(
  db: StackdDb,
  screen: string,
  layout: CardLayout<Id>,
): Promise<void> {
  const { order, hidden } = layout;
  await db.settings.put({
    key: layoutKey(screen),
    value: { order, hidden },
    updated_at: new Date().toISOString(),
  });
}

/** Move one card from one place to another in the order. */
export function moveCard<Id>(order: Id[], from: number, to: number): Id[] {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order;
  const next = [...order];
  const [card] = next.splice(from, 1);
  if (card !== undefined) next.splice(to, 0, card);
  return next;
}

/** The cards to draw, in order, leaving out the switched-off ones (nothing until it's read). */
export function shownCards<Id extends string>(layout: CardLayout<Id>): Id[] {
  if (!layout.ready) return [];
  const hidden = new Set(layout.hidden);
  return layout.order.filter((id) => !hidden.has(id));
}
