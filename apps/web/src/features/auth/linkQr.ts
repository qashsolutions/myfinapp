/**
 * The QR code the computer shows for "Link with your phone" (B2, October 19, 2026). The library
 * (`qrcode-generator`, MIT, no dependencies) loads only on that screen; it returns the module
 * grid and the screen draws it as one SVG path in the app's own colours.
 */

/** Where the phone's camera lands: the approval screen, with the code filled in. */
export function linkUrl(code: string, origin = window.location.origin): string {
  return `${origin}/link?code=${encodeURIComponent(code.replace(/[^A-Z0-9]/gi, "").toUpperCase())}`;
}

export interface QrPath {
  /** Modules per side, the quiet zone included. */
  size: number;
  /** One `M x y h1 v1 h-1 z` square per dark module. */
  d: string;
}

const QUIET = 2;

export async function qrPath(text: string): Promise<QrPath> {
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const parts: string[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) parts.push(`M${c + QUIET} ${r + QUIET}h1v1h-1z`);
  return { size: n + QUIET * 2, d: parts.join("") };
}
