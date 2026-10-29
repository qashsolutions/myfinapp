import { SPEND_LESS } from "../whatif/WhatIfScreen.tsx";

/**
 * The amount a "room" category opens What if → Spend less with (October 29, 2026): the largest
 * of What if's own suggested amounts that fits inside the category's flexible spending, else
 * that spending itself. No new number: the suggestions are What if's.
 */
export function roomAmount(flexibleCents: number): number {
  const fits = SPEND_LESS.filter((p) => p <= flexibleCents);
  return fits.length ? Math.max(...fits) : flexibleCents;
}

/** `/what-if?lever=spend&category=…&amount=…`, the prefill What if already reads. */
export function roomWhatIfLink(categoryId: string, flexibleCents: number): string {
  const q = new URLSearchParams({
    lever: "spend",
    category: categoryId,
    amount: String(roomAmount(flexibleCents)),
  });
  return `/what-if?${q.toString()}`;
}
