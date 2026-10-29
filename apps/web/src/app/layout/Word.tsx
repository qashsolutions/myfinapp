/**
 * The one word every card leads with (owner decision, October 25, 2026: one word of value to the
 * person, then a short line). Words that ask for a look are red, words of progress green.
 */
export const BAD_WORDS: ReadonlySet<string> = new Set([
  "Over",
  "Tight",
  "Down",
  "Behind",
  "Short",
  "Review",
  "Stalled",
]);
export const GOOD_WORDS: ReadonlySet<string> = new Set([
  "Kept",
  "Room",
  "Up",
  "Ahead",
  "Covered",
  "Sorted",
  "Steady",
  "Saved",
  "Saving",
  "Reached",
  "Found",
  "Done",
  "Clear",
  "All good",
  "On track",
  "Sooner",
]);

export function wordTone(word: string): "good" | "bad" | "plain" {
  return BAD_WORDS.has(word) ? "bad" : GOOD_WORDS.has(word) ? "good" : "plain";
}

export function Word({ children, className = "" }: { children: string; className?: string }) {
  return <p className={`word word--${wordTone(children)} ${className}`.trim()}>{children}</p>;
}
