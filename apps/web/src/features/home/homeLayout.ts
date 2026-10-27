import {
  type CardLayout,
  moveCard,
  normalizeCards,
  saveCardLayout,
  useCardLayout,
} from "../../app/layout/cardLayout.ts";
import type { StackdDb } from "../../data/db.ts";

/** Home's cards, in their default order (owner decision, October 19, 2026: drag the ones you care
 * about into your own order and hide the rest). */
export const HOME_CARDS = [
  ["kept", "This month", "Kept, with money in and out"],
  ["found", "Found in your statements", "Bills and pay to confirm"],
  ["where", "Where it went", "Spending by category"],
  ["aside", "Set aside", "This month's saving"],
  ["move", "Next move", "One thing worth doing now"],
  ["next30", "Next 30 days", "Safe to spend and your balance"],
  ["setup", "Make Qash yours", "Your next steps, if you want them"],
  ["budget", "Budget", "On track or over"],
  ["jars", "Jars", "Your saving jars"],
  ["challenge", "Challenge", "Your group challenge"],
  ["recent", "Recent entries", "The latest money in and out"],
] as const;

export type HomeCardId = (typeof HOME_CARDS)[number][0];
export const DEFAULT_ORDER: HomeCardId[] = HOME_CARDS.map(([id]) => id);
/** Small cards that sit side by side when they follow one another. */
export const TILE_CARDS: ReadonlySet<HomeCardId> = new Set(["budget", "jars", "challenge"]);

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
