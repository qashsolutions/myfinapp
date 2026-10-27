import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import { biometricName, isNativePlatform } from "../../lib/platform.ts";
import { preferPhoneNext } from "../security/webauthn.ts";

/** A computer (not a phone or tablet, not the native app): the only place this help appears. */
export function onComputer(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
) {
  return !/iPhone|iPad|iPod|Android/.test(userAgent) && !isNativePlatform();
}

/** "No Touch ID on this computer?" / "No Windows Hello…"; elsewhere a plain fingerprint line. */
export function helpLabel(): string {
  const bio = biometricName();
  return bio === "Touch ID" || bio === "Windows Hello"
    ? `No ${bio} on this computer?`
    : "No fingerprint reader on this computer?";
}

const STEPS = [
  ["Tap “Show the QR code” below", "Your browser draws the code on this screen."],
  ["Scan it with your phone's camera", "No app to install."],
  ["Confirm on your phone", "Face ID or fingerprint. You're in."],
] as const;

/**
 * "No Touch ID on this computer?" (owner decision, October 14, 2026: passkeys only, with a
 * clearer path). Every browser already offers a phone as the passkey through its own QR code;
 * this shows how, with a drawing, plus the computer's own PIN or a security key.
 */
export function NoBiometricsHelp({ onUsePhone }: { onUsePhone: () => void }) {
  const [open, setOpen] = useState(false);
  if (!onComputer()) return null;
  return (
    <>
      <button type="button" className="auth__link auth__nobio" onClick={() => setOpen(true)}>
        {helpLabel()}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Use your phone instead">
        <PhoneQrArt />
        <ol className="nobio__steps">
          {STEPS.map(([t, d], i) => (
            <li key={t}>
              <span className="nobio__n" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <strong>{t}</strong>
                <span>{d}</span>
              </span>
            </li>
          ))}
        </ol>
        <BluetoothHint />
        <Button
          block
          onClick={() => {
            setOpen(false);
            preferPhoneNext();
            onUsePhone();
          }}
        >
          Show the QR code
        </Button>
        <p className="nobio__more">
          Your browser may also offer this computer's PIN or password, or a security key.
        </p>
      </Sheet>
    </>
  );
}

/**
 * The phone and the computer talk over Bluetooth during this sign-in, so a browser without
 * Bluetooth permission shows a "needs permission" box instead of the QR code (owner, October 19,
 * 2026: Chrome on a Mac did this). Where to turn it on, for the computer in front of them.
 */
export function BluetoothHint({
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
}: {
  userAgent?: string;
}) {
  const mac = /Macintosh|Mac OS X/.test(userAgent);
  const windows = /Windows/.test(userAgent);
  return (
    <div className="nobio__bt" role="note">
      <svg className="nobio__bt-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
        <path
          d="M7 7l10 10-5 4V3l5 4L7 17"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        <strong>Bluetooth on, on both</strong>
        <span>
          {mac
            ? "Asked for permission? System Settings → Privacy & Security → Bluetooth → your browser on. Then quit the browser (⌘Q) and reopen it."
            : windows
              ? "Asked for permission? Settings → Bluetooth & devices → Bluetooth on. Then reopen the browser."
              : "Your phone and computer connect over Bluetooth for this."}
        </span>
      </span>
    </div>
  );
}

/** The small decorative QR pattern (not a real code): cell positions inside the 72px tile. */
const QR_ROWS = ["001101", "101000", "011011", "110101", "001110", "100101"];
const QR_CELLS: Array<{ id: string; x: number; y: number }> = [];
for (const [r, row] of QR_ROWS.entries())
  for (const [c, bit] of [...row].entries())
    if (bit === "1") {
      const x = 30 + (c % 3) * 6 + (c > 2 ? 16 : 0);
      const y = 30 + r * 6;
      QR_CELLS.push({ id: `q${x}-${y}`, x, y });
    }

/** Laptop showing a QR code, a phone scanning it, a check: the hybrid passkey flow. */
function PhoneQrArt() {
  return (
    <svg className="nobio__art" viewBox="0 0 320 170" aria-hidden="true">
      <rect x="20" y="20" width="170" height="108" rx="10" fill="var(--c-ink)" />
      <rect x="27" y="27" width="156" height="94" rx="5" fill="var(--c-card)" />
      <path d="M8 132 h194 l-10 12 H18 z" fill="var(--c-ink)" opacity="0.85" />
      <g transform="translate(77 38)">
        <rect width="72" height="72" rx="6" fill="var(--c-bg)" />
        {[0, 1, 2].map((k) => {
          const [x, y] = k === 0 ? [6, 6] : k === 1 ? [46, 6] : [6, 46];
          return (
            <g key={k}>
              <rect x={x} y={y} width="20" height="20" rx="4" fill="var(--c-ink)" />
              <rect x={x + 5} y={y + 5} width="10" height="10" rx="2" fill="var(--c-bg)" />
            </g>
          );
        })}
        {QR_CELLS.map((cell) => (
          <rect
            key={cell.id}
            x={cell.x}
            y={cell.y}
            width="5"
            height="5"
            rx="1"
            fill="var(--c-a1)"
          />
        ))}
      </g>
      <path
        d="M196 74 C 214 74, 214 74, 232 74"
        stroke="var(--c-a1)"
        strokeWidth="2.5"
        strokeDasharray="5 5"
        fill="none"
      />
      <g transform="translate(236 26)">
        <rect width="64" height="124" rx="14" fill="var(--c-ink)" />
        <rect x="5" y="5" width="54" height="114" rx="10" fill="var(--c-card)" />
        <rect x="23" y="10" width="18" height="4" rx="2" fill="var(--c-ink)" />
        <rect
          x="14"
          y="30"
          width="36"
          height="36"
          rx="6"
          fill="none"
          stroke="var(--c-a1)"
          strokeWidth="2.5"
          strokeDasharray="10 6"
        />
        <circle cx="32" cy="92" r="13" fill="var(--c-success)" />
        <path
          d="M26 92 l4 4 l8 -9"
          fill="none"
          stroke="var(--c-on-accent)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
