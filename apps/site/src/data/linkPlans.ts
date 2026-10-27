/**
 * Plan names link to their plan (owner, October 16, 2026: "wherever we talk about our plans,
 * provide a link to the plan"). Escapes the text, then turns each capitalised "Private" or
 * "Connected" into a link to /pricing#private or #connected. For our own copy only, rendered
 * with set:html.
 */
export function linkPlans(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped.replace(
    /\b(Private|Connected)\b/g,
    (name) => `<a class="plan-link" href="/pricing#${name.toLowerCase()}">${name}</a>`,
  );
}
