/**
 * Recent in search: the ids of the last places opened from it, on this device only, per account.
 * Never what was typed. Cleared by signing out (`forgetSearchRecents`) and by deleting the
 * account (every `stackd.` key goes).
 */
const PREFIX = "stackd.search.recent.";
const MAX = 5;

export function searchRecents(userId: string | null | undefined): string[] {
  if (!userId) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + userId) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string").slice(0, MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberSearchPick(userId: string | null | undefined, id: string): void {
  if (!userId) return;
  const next = [id, ...searchRecents(userId).filter((v) => v !== id)].slice(0, MAX);
  try {
    localStorage.setItem(PREFIX + userId, JSON.stringify(next));
  } catch {
    // storage unavailable: Recent just stays empty
  }
}

export function clearSearchRecents(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(PREFIX + userId);
  } catch {
    // storage unavailable: nothing to clear
  }
}

/** Every account's Recent on this device. */
export function forgetSearchRecents(): void {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing to clear
  }
}
