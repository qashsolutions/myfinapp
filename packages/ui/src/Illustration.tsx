/**
 * Hand-drawn spot illustrations for empty states. The style is deliberately human: slightly
 * wobbly ink lines (round caps, uneven curves) over a flat colour wash printed a few pixels
 * off the line, like a risograph. No gradients, no gloss. Ink is the look's `--c-ink`, the wash
 * one of its accents, so every look draws them in its own colours. Decorative: `aria-hidden`,
 * and hidden in Simple layout (`sk-decor`), because the sentence next to it says the same thing.
 */

import { cx } from "./cx.ts";

export type IllustrationName =
  | "jar"
  | "receipt"
  | "calendar"
  | "friends"
  | "card"
  | "sprout"
  | "bank";

export interface IllustrationProps {
  name: IllustrationName;
  tone?: "a1" | "a2" | "a3";
  className?: string;
}

// The wash: one loose blob per drawing, offset from the ink.
const WASH: Record<IllustrationName, string> = {
  jar: "M30 46 q-4 -28 30 -30 q30 0 32 28 q4 34 -30 40 q-34 4 -32 -38 z",
  receipt: "M36 18 q26 -6 48 4 q6 34 0 66 q-24 6 -48 -2 q-6 -34 0 -68 z",
  calendar: "M26 30 q34 -10 70 2 q6 26 -2 54 q-34 8 -66 -2 q-8 -26 -2 -54 z",
  friends: "M20 62 q2 -34 40 -36 q40 0 42 34 q0 28 -40 28 q-42 0 -42 -26 z",
  card: "M20 34 q40 -10 82 2 q4 22 -2 44 q-42 8 -82 -2 q-4 -22 2 -44 z",
  sprout: "M34 60 q-2 -36 30 -40 q30 0 28 32 q-2 36 -30 38 q-28 0 -28 -30 z",
  bank: "M24 44 q36 -24 74 0 q6 22 -2 40 q-36 8 -70 0 q-8 -18 -2 -40 z",
};

const INK: Record<IllustrationName, string[]> = {
  jar: [
    "M44 17 q16 -3 32 0 l1 8 q-17 2 -34 0 z",
    "M41 26 q-9 5 -8 15 l0 37 q0 12 14 13 l27 0 q14 -1 14 -13 l0 -37 q0 -10 -8 -15",
    "M36 52 q24 4 48 0",
    "M93 18 l4 -6 M97 27 l7 -1 M90 10 l1 -7",
  ],
  receipt: [
    "M38 13 q22 -2 44 1 l0 74 l-6 -4 l-6 4 l-6 -4 l-6 4 l-6 -4 l-6 4 l-6 -4 l-2 2 z",
    "M46 30 h26 M46 42 h19 M46 54 h24",
    "M46 70 h12 M64 70 q5 -1 10 0",
  ],
  calendar: [
    "M30 25 q30 -2 60 0 l2 57 q-32 3 -64 0 z",
    "M30 39 q31 2 62 0",
    "M46 17 v14 M74 17 v14",
    "M68 61 q10 -9 15 2 q-2 11 -14 6 q-6 -3 -1 -8",
  ],
  friends: [
    "M44 40 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0",
    "M76 41 m-10 0 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0",
    "M27 80 q17 -27 33 0 M59 80 q17 -27 33 0",
    "M98 20 v40 M98 21 q10 4 17 -2 q-4 8 0 14 q-8 5 -17 2",
  ],
  card: [
    "M22 33 q38 -3 76 0 l2 44 q-40 3 -80 0 z",
    "M22 45 q39 2 78 0",
    "M32 56 h14 v10 h-14 z",
    "M58 67 h8 M70 67 h8 M82 67 h7",
  ],
  sprout: [
    "M44 66 q16 3 32 0 l-4 22 q-12 2 -24 0 z",
    "M60 66 q-1 -18 2 -30",
    "M61 45 q-16 -10 -22 2 q12 6 22 -2",
    "M62 38 q14 -14 24 -4 q-10 10 -24 4",
    "M88 22 m-6 0 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0",
  ],
  bank: [
    "M28 37 l32 -19 l33 19 z",
    "M38 43 v30 M52 43 v30 M68 43 v30 M82 43 v30",
    "M26 79 q34 3 68 0",
    "M60 28 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0",
  ],
};

export function Illustration({ name, tone = "a1", className }: IllustrationProps) {
  return (
    <svg
      className={cx("sk-illo", "sk-decor", className)}
      viewBox="0 0 120 100"
      width="120"
      height="100"
      aria-hidden="true"
      focusable="false"
      data-illo={name}
    >
      <path d={WASH[name]} className={`sk-illo__wash sk-illo__wash--${tone}`} />
      <g className="sk-illo__ink">
        {INK[name].map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
