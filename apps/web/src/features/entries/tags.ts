/** Tags and notes on entries (owner decision, October 19, 2026). */

export const MAX_TAGS = 5;
export const TAG_MAX = 24;
export const NOTE_MAX = 200;

/** "  #Hawaii   trip " → "Hawaii trip"; empty when nothing is left. */
export function tidyTag(text: string): string {
  return text.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, TAG_MAX).trim();
}

/** Add a tag unless one with the same letters (any case) is there, or the entry has MAX_TAGS. */
export function addTag(tags: string[], text: string): string[] {
  const tag = tidyTag(text);
  if (!tag || tags.length >= MAX_TAGS) return tags;
  if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return tags;
  return [...tags, tag];
}

/** Existing tags that start with what is typed (any case), not already on the entry, at most 5. */
export function suggestTags(all: string[], typed: string, chosen: string[]): string[] {
  const q = tidyTag(typed).toLowerCase();
  const taken = new Set(chosen.map((t) => t.toLowerCase()));
  return all
    .filter((t) => !taken.has(t.toLowerCase()) && (q === "" || t.toLowerCase().startsWith(q)))
    .slice(0, 5);
}
