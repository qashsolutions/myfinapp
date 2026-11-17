import {
  type CardLayout,
  moveCard,
  normalizeCards,
  saveCardLayout,
  useCardLayout,
} from "../../app/layout/cardLayout.ts";
import type { StackdDb } from "../../data/db.ts";

/** Home's cards, in their default order (owner decision, October 19, 2026: drag the ones you care
 * about into your own order and hide the rest). What the person set up (Budget, Jars, Split bills,
 * the challenge) comes right after This month, each a full card (owner, November 17, 2026); each
 * stays hidden until there's something to show. */
export const HOME_CARDS = [
  ["kept", "This month", "Kept, with money in and out"],
  ["month_review", "Your month", "Last month at a glance, in its first week"],
  ["budget", "Budget", "On track or over, and what's left"],
  ["jars", "Jars", "Your top jars and their pace"],
  ["owed", "Split bills", "Who owes whom in your groups, when anyone does"],
  ["challenge", "Challenge", "Your group challenge"],
  ["found", "Found in your statements", "Bills and pay to confirm"],
  ["where", "Where it went", "Spending by category"],
  ["aside", "Set aside", "This month's saving"],
  ["move", "Next move", "One thing worth doing now"],
  ["next30", "Next 30 days", "Safe to spend and your balance"],
  ["debt_free", "Debt payoff", "When your debts are paid off"],
  ["sub_check", "Subscription check", "Still using it? Only when there's a question"],
  ["setup", "Make Qash yours", "Your next steps, if you want them"],
  ["recent", "Recent entries", "The latest money in and out"],
] as const;

export type HomeCardId = (typeof HOME_CARDS)[number][0];
export const DEFAULT_ORDER: HomeCardId[] = HOME_CARDS.map(([id]) => id);

export type HomeLayout = CardLayout<HomeCardId>;

const SCREEN = "home"; // settings key "home.layout", as since October 19, 2026

/** A saved layout made whole: unknown ids dropped, cards added since it was saved appended. */
export function normalizeLayout(raw: unknown): HomeLayout {
  return normalizeCards(raw, DEFAULT_ORDER);
}

/** The saved layout (synced with the backup like other settings), or the default. */
export function useHomeLayout(): HomeLayout {
  return useCardLayout(SCREEN, HOME_CARDS);
}

export async function saveHomeLayout(db: StackdDb, layout: HomeLayout): Promise<void> {
  await saveCardLayout(db, SCREEN, layout);
}

export { moveCard };
