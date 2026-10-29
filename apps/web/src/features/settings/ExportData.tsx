import "../auth/auth.css";

import { Button } from "@stackd/ui";
import { useState } from "react";
import { api, type ExportOut, failureOf } from "../../data/api.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { collectExport, downloadBytes, zipStore } from "../../data/export.ts";
import { recordExport } from "../../data/persist.ts";
import { todayIso } from "../../lib/format.ts";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "../security/StepUpPrompt.tsx";

/** The last ZIP built, for tests and the confirmation line (no download in jsdom). */
export const exportState: { lastZip: Uint8Array | null; lastName: string | null } = {
  lastZip: null,
  lastName: null,
};

/** "Download all my data": step-up, one server request, then the ZIP is built and saved here. */
export function ExportData({
  label = "Download all my data",
  onSaved,
}: {
  label?: string;
  /** After the file was handed to the browser (the "keep it safe" card hides then). */
  onSaved?: () => void;
}) {
  const { db } = useDb();
  const userId = useSession().info?.user?.id ?? null;
  const stepUp = useStepUp();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setStatus(null);
    if (!(await stepUp.confirm("Downloading all your data"))) return;
    setBusy(true);
    try {
      let server: ExportOut | null = null;
      const r = await api.POST("/api/account/export");
      const failure = failureOf(r);
      if (failure && failure.code !== "step_up_required") {
        setStatus(
          "Couldn't reach the server for your account details; the export has only what's on this device.",
        );
      } else if (!failure) server = r.data ?? null;
      const at = new Date();
      const files = await collectExport(db, server, at.toISOString());
      const zip = zipStore(files, at);
      const name = `stackd-export-${todayIso()}.zip`;
      exportState.lastZip = zip;
      exportState.lastName = name;
      const saved = downloadBytes(zip, name);
      if (saved && userId) recordExport(userId);
      if (saved) onSaved?.();
      setStatus(
        saved
          ? `Saved ${name} (${files.length} files). Keep it somewhere safe; it holds your money data. Your backup and household keys aren't in it: they stay on this device, and nothing changes for you.`
          : `Prepared ${name} (${files.length} files), but this browser didn't offer a download.`,
      );
    } catch {
      setStatus("Couldn't build the export. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button block variant="secondary" onClick={run} disabled={busy}>
        {label}
      </Button>
      {status ? (
        <p className="auth__hint" role="status">
          {status}
        </p>
      ) : null}
    </>
  );
}
