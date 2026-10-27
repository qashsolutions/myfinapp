/**
 * Default categories (docs/spec.md "Budgeting"): Rent, Groceries, Utilities & phone, Transport,
 * Insurance, Dining, Shopping, Subscriptions, Fun, Savings, Debt payoff, Other. Users can rename
 * and add. Buckets map to 50/30/20 (need / want / save); the "Other" → want mapping is proposed.
 *
 * Money in needs its own categories (mockup F5Receipt: Paycheck, Side income, Refund, Other);
 * they carry no bucket because income is not spending.
 */

import type { Account, Category } from "./db.ts";

export const DEFAULT_CATEGORIES: Category[] = [
  { id: "cat-rent", name: "Rent", kind: "expense", bucket: "need", is_default: true, sort: 10 },
  {
    id: "cat-groceries",
    name: "Groceries",
    kind: "expense",
    bucket: "need",
    is_default: true,
    sort: 20,
  },
  {
    id: "cat-utilities",
    name: "Utilities & phone",
    kind: "expense",
    bucket: "need",
    is_default: true,
    sort: 30,
  },
  {
    id: "cat-transport",
    name: "Transport",
    kind: "expense",
    bucket: "need",
    is_default: true,
    sort: 40,
  },
  {
    id: "cat-insurance",
    name: "Insurance",
    kind: "expense",
    bucket: "need",
    is_default: true,
    sort: 50,
  },
  { id: "cat-dining", name: "Dining", kind: "expense", bucket: "want", is_default: true, sort: 60 },
  {
    id: "cat-shopping",
    name: "Shopping",
    kind: "expense",
    bucket: "want",
    is_default: true,
    sort: 70,
  },
  {
    id: "cat-subscriptions",
    name: "Subscriptions",
    kind: "expense",
    bucket: "want",
    is_default: true,
    sort: 80,
  },
  { id: "cat-fun", name: "Fun", kind: "expense", bucket: "want", is_default: true, sort: 90 },
  {
    id: "cat-savings",
    name: "Savings",
    kind: "expense",
    bucket: "save",
    is_default: true,
    sort: 100,
  },
  {
    id: "cat-debt-payoff",
    name: "Debt payoff",
    kind: "expense",
    bucket: "save",
    is_default: true,
    sort: 110,
  },
  { id: "cat-other", name: "Other", kind: "expense", bucket: "want", is_default: true, sort: 120 },
  {
    id: "cat-paycheck",
    name: "Paycheck",
    kind: "income",
    bucket: null,
    is_default: true,
    sort: 10,
  },
  {
    id: "cat-side-income",
    name: "Side income",
    kind: "income",
    bucket: null,
    is_default: true,
    sort: 20,
  },
  { id: "cat-refund", name: "Refund", kind: "income", bucket: null, is_default: true, sort: 30 },
  {
    id: "cat-other-income",
    name: "Other",
    kind: "income",
    bucket: null,
    is_default: true,
    sort: 40,
  },
];

/** Every device starts with a cash account so a manual entry always has somewhere to go. */
export const DEFAULT_ACCOUNT: Omit<Account, "created_at"> = {
  id: "acct-cash",
  label: "Cash",
  type: "cash",
  last4: null,
  institution: null,
  currency: "USD",
};
