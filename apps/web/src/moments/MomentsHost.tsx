import "./moments.css";

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useDb } from "../data/DbProvider.tsx";
import type { StackdDb } from "../data/db.ts";
import { prefersReducedMotion } from "../lib/platform.ts";
import { type Moment, onMoment } from "./bus.ts";
import { eventOf, toastText } from "./catalog.ts";
import { throwConfetti } from "./confetti.ts";
import { getMomentPref } from "./prefs.ts";
import { playSound } from "./sound.ts";

const SHOW_MS = 4500;

/** Local today and month, for the catalog's `once` rule (the user's own calendar). */
function period(once: string, now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  if (once === "per_month") return `${y}-${m}`;
  return `${y}-${m}-${String(now.getDate()).padStart(2, "0")}`;
}

/** True the first time this moment may show in its period (catalog `once`); records it. */
export async function firstTimeFor(db: StackdDb, m: Moment, now = new Date()): Promise<boolean> {
  const once = eventOf(m.type).once ?? "always";
  if (once === "always") return true;
  const key = `moments.once.${m.type}.${m.seed}.${period(once, now)}`;
  if (await db.settings.get(key)) return false;
  await db.settings.put({ key, value: true, updated_at: now.toISOString() });
  return true;
}

function isTestDom(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");
}

/**
 * Shows each moment once: its toast (a polite status line above the tab bar, bottom-right on
 * a desktop) and its effects (sound when Sounds is on; confetti when Celebrations is on and the
 * device doesn't ask for reduced motion). Mounted once in AppShell.
 */
export function MomentsHost() {
  const { db } = useDb();
  const [queue, setQueue] = useState<
    Array<{ id: number; text: string; action?: { label: string; to: string } }>
  >([]);
  const next = useRef(0);

  useEffect(
    () =>
      onMoment((m) => {
        void (async () => {
          // The database closes on sign-out (and between tests); a late moment just drops.
          const first = await firstTimeFor(db, m).catch(() => false);
          if (!first) return;
          const ev = eventOf(m.type);
          const effects = ev.effects ?? { sound: "none", confetti: "none" };
          if (getMomentPref("sounds")) playSound(effects.sound);
          if (getMomentPref("celebrations") && !prefersReducedMotion() && !isTestDom())
            throwConfetti(effects.confetti, m.seed);
          const text = toastText(m.type, m.vars, m.seed);
          if (text) {
            next.current += 1;
            const id = next.current;
            setQueue((q) => [...q.slice(-2), { id, text, action: ev.action }]);
          }
        })();
      }),
    [db],
  );

  const current = queue[0];
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => setQueue((q) => q.slice(1)), SHOW_MS);
    return () => clearTimeout(timer);
  }, [current]);

  return (
    <div className="moment-toast-region" aria-live="polite" aria-atomic="true">
      {current ? (
        <div className="moment-toast" key={current.id}>
          <span className="moment-toast__text">
            {current.text}
            {current.action ? (
              <>
                {" "}
                <Link
                  className="moment-toast__link"
                  to={current.action.to}
                  onClick={() => setQueue((q) => q.slice(1))}
                >
                  {current.action.label}
                </Link>
              </>
            ) : null}
          </span>
          <button
            type="button"
            className="moment-toast__close"
            aria-label="Dismiss"
            onClick={() => setQueue((q) => q.slice(1))}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}
