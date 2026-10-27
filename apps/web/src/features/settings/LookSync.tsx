import { useEffect, useRef } from "react";
import { useTheme } from "../../app/ThemeProvider.tsx";
import { useSession } from "../auth/useSession.tsx";

/**
 * The account's saved look arrives with the session (users.look). In a native app it is the
 * truth across devices, so it is adopted when it first arrives and whenever it changes on the
 * server; a response that merely repeats what was adopted before is ignored, so a stale session
 * read never undoes a switch made a moment ago. The PWA's ThemeProvider ignores this entirely.
 */
export function LookSync() {
  const { info } = useSession();
  const { adoptSavedLook } = useTheme();
  const saved = info?.user?.look ?? null;
  const adopted = useRef<string | null>(null);
  useEffect(() => {
    if (saved === null || saved === adopted.current) return;
    adopted.current = saved;
    adoptSavedLook(saved);
  }, [saved, adoptSavedLook]);
  return null;
}
