/**
 * Whether `word` is readable in `text` (a request's URL and body, or a stored ciphertext): as a
 * whole token, not inside a longer run of base64url letters. Ciphertext is base64url, where a
 * short word ("4B", "1250", "Trip") turns up by chance now and then (CI, November 10, 2026);
 * readable JSON, a URL or plain text always sets it apart with a quote, space, colon or slash.
 */
export function readableIn(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(text);
}
