import { Chip, List, ListRow } from "@stackd/ui";
import { useEffect, useState } from "react";
import { type ActivityOut, api } from "../../data/api.ts";
import { shortDate, shortTime } from "../../lib/dates.ts";

const KIND: Record<string, string> = {
  sign_in: "Signed in",
  sign_in_failed: "Failed sign-in attempt",
  sign_out: "Signed out",
  device_signed_out: "Signed out a device",
  passkey_added: "Passkey added",
  passkey_removed: "Passkey removed",
  email_changed: "Email changed",
  export: "Data downloaded",
  lock_changed: "Auto-lock changed",
};

/**
 * Settings → Sign-in & security → Recent activity (October 13, 2026): the last 30 days of
 * sign-ins, failed attempts (a wrong email code) and security changes, newest first, so a user
 * can spot anything that was not them.
 */
export function RecentActivity() {
  const [items, setItems] = useState<ActivityOut[] | null>(null);
  useEffect(() => {
    void api.GET("/api/security/activity").then(({ data }) => {
      if (data) setItems(data);
    });
  }, []);
  if (!items) return null;
  return (
    <section aria-labelledby="activity-h">
      <h2 className="section-title" id="activity-h">
        Recent activity
      </h2>
      {items.length === 0 ? (
        <p className="auth__hint">Nothing in the last 30 days.</p>
      ) : (
        <List card aria-labelledby="activity-h">
          {items.slice(0, 20).map((a) => (
            <ListRow
              key={`${a.at}-${a.kind}`}
              label={KIND[a.kind] ?? a.kind}
              sublabel={`${a.device_label ? `${a.device_label} · ` : ""}${shortDate(a.at)}, ${shortTime(a.at)}`}
              value={a.kind === "sign_in_failed" ? <Chip tone="warning">Check</Chip> : undefined}
            />
          ))}
        </List>
      )}
      <p className="auth__fineprint">
        Last 30 days. If something here wasn't you, sign out that device above and remove any
        passkey you don't recognise. IP addresses are never stored in a readable form.
      </p>
    </section>
  );
}
