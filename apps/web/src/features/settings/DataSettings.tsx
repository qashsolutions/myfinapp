import "../auth/auth.css";

import { Card, List, ListRow } from "@stackd/ui";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { RetentionSettings } from "../receipts/RetentionSettings.tsx";
import { ExportData } from "./ExportData.tsx";
import { StorageStatus } from "./StorageStatus.tsx";

/** Me → Money & data: accounts, linked banks, receipt photos, what's stored here, export. */
export function DataSettings() {
  const navigate = useNavigate();
  const go = (path: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(path);
  };
  return (
    <>
      <ScreenHeader title="Money & data" actions={null} back="/me" />
      <List card aria-label="Accounts">
        <ListRow
          label="Accounts & imports"
          sublabel="Balances and statements"
          href="/me/accounts"
          onClick={go("/me/accounts")}
        />
        <ListRow
          label="Categories"
          sublabel="Your own, rules and names"
          href="/me/categories"
          onClick={go("/me/categories")}
        />
        <ListRow
          label="Linked banks & cards"
          sublabel="Read-only, optional, disconnect any time"
          href="/me/linking"
          onClick={go("/me/linking")}
        />
      </List>
      <div id="set-receipts">
        <RetentionSettings />
      </div>
      <div id="set-storage">
        <StorageStatus />
      </div>
      <Card as="section" aria-labelledby="export-h" id="set-export">
        <h2 className="sk-card__title" id="export-h">
          Download all my data
        </h2>
        <p>
          A ZIP with your profile, entries, goals, groups, budgets, settings and receipt photos,
          built on this device.
        </p>
        <ExportData />
      </Card>
    </>
  );
}
