/** Link codes (B1–B3, October 19, 2026): 8 letters and digits from the server's alphabet (no 0, O,
 * 1 or I), shown as "ABCD-EFGH". */
const ALPHABET = /^[A-HJ-NP-Z2-9]{8}$/;

/** What someone typed, tidied: capitals, no spaces or dashes, a dash after four. The codes have no
 * 0, O, 1 or I, so those simply don't make a valid code. */
export function tidyCode(input: string): string {
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** A complete code, or null. */
export function completeCode(input: string): string | null {
  const raw = tidyCode(input).replace("-", "");
  return ALPHABET.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
}

/** The code inside a scanned QR: only this app's own /link?code= address, or the bare letters.
 * Any other address is refused, so a planted code can't send the phone somewhere else. */
export function codeFromScan(text: string, origin = window.location.origin): string | null {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    if (url.origin !== origin || url.pathname !== "/link") return null;
    return completeCode(url.searchParams.get("code") ?? "");
  } catch {
    return /^[A-Za-z0-9-]{8,9}$/.test(trimmed) ? completeCode(trimmed) : null;
  }
}
