import { Card, List, ListRow } from "@stackd/ui";
import { useState } from "react";
import { SITE_URL } from "../../lib/brand.ts";

/** Settings → Privacy & legal: policy and terms open as web pages; the rest is in-app. */
export function PrivacyLegal() {
  const [showNever, setShowNever] = useState(false);
  const site = SITE_URL || "https://qash.solutions";
  return (
    <section aria-labelledby="legal-h">
      <h2 className="section-title" id="legal-h">
        Privacy & legal
      </h2>
      <List card>
        <ListRow label="Privacy policy" href={`${site}/privacy`} />
        <ListRow label="Terms of service" href={`${site}/terms`} />
        <ListRow label="Data we never collect" onClick={() => setShowNever((v) => !v)} chevron />
        <ListRow label="Open-source licenses" href={`${site}/licenses`} />
        <ListRow
          label="Help & contact"
          sublabel="support@qash.solutions · replies in 5 to 7 business days"
          href="mailto:support@qash.solutions"
        />
      </List>
      {showNever ? (
        <Card as="section" aria-label="Data we never collect">
          <ul>
            <li>
              Bank passwords or logins. Linking is read-only through Plaid, on your bank's own page.
            </li>
            <li>
              Your transactions, statements, receipts, budgets or jars, on our servers. They live on
              this device; on Connected, linked transactions pass through without being stored.
            </li>
            <li>Other members' amounts. Groups share percentages and display names only.</li>
            <li>
              Location or camera details from receipt photos; they are stripped before saving.
            </li>
            <li>Anything for advertising. No ad trackers, no data sales.</li>
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
