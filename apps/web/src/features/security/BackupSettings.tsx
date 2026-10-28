import "../auth/auth.css";

import { Button, Card, List, ListRow, Sheet } from "@stackd/ui";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api, failureOf } from "../../data/api.ts";
import {
  BackupError,
  disableBackup,
  enableBackup,
  LAST_SYNC_SETTING,
  localKey,
  prfSalt,
  pushBackup,
  RECOVERY_SETTING,
  restoreWithPasskey,
  restoreWithRecoveryKey,
} from "../../data/backup/sync.ts";
import { useDb } from "../../data/DbProvider.tsx";
import { engine } from "../../engine/bridge.ts";
import { shortDate, shortTime } from "../../lib/dates.ts";
import { biometricName } from "../../lib/platform.ts";
import { useSession } from "../auth/useSession.tsx";
import { useEntitlements } from "../billing/entitlements.ts";
import { PlanLimit } from "../billing/PlanLimit.tsx";
import { useStepUp } from "./StepUpPrompt.tsx";
import { assertPasskeyWithPrf, PasskeyError } from "./webauthn.ts";

type Status = {
  enabled: boolean;
  available: boolean;
  key: {
    key_version: number;
    recovery_wrapped: string;
    recovery_salt: string;
    passkey_wrapped: string | null;
    passkey_salt: string | null;
    passkey_credential_id: string | null;
  } | null;
  latest: { id: string; created_at: string; size: number; device_label: string } | null;
  devices: Array<{ label: string; last_backup_at: string }>;
};

/** For tests: the last recovery key shown on this device. */
export const backupUiState: { lastRecoveryKey: string | null } = { lastRecoveryKey: null };

/**
 * Me → Security & backup → Encrypted backup (mockup F6Security; docs/spec.md "End-to-end
 * encrypted backup", "Backup & devices row"). Private and Connected only: turn backup on (the key
 * is made here; the recovery key is shown once and can be shown again), see the last backup,
 * back up now, restore on a new device with the passkey or the recovery key, the devices that
 * sync, and turn backup off. Free sees the export reminder instead.
 */
export function BackupSettings() {
  const { db } = useDb();
  const { info, unlocked } = useSession();
  const stepUp = useStepUp();
  const userId = info?.user?.id ?? "";
  const { entitlements } = useEntitlements();
  const [status, setStatus] = useState<Status | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.GET("/api/backup");
    if (!failureOf(r) && r.data) setStatus(r.data as Status);
    setHasKey((await localKey(db)) !== null);
    setRecovery(((await db.settings.get(RECOVERY_SETTING))?.value as string | undefined) ?? null);
    setLastSync(((await db.settings.get(LAST_SYNC_SETTING))?.value as string | undefined) ?? null);
  }, [db]);
  useEffect(() => {
    void load();
  }, [load]);

  function explain(err: unknown): string {
    if (err instanceof BackupError) {
      if (err.code === "offline") return "You're offline. Try again when connected.";
      if (err.code === "plan_required") return "Backup is part of Private and Connected.";
      if (err.code === "wrong_recovery_key")
        return "That recovery key doesn't match. Check it and try again.";
      if (err.code === "backup_gone")
        return "Your backups changed while restoring (another device backed up). Try again.";
      if (err.code === "wrong_passkey")
        return `This ${biometricName()} can't open the backup here. Enter your recovery key instead.`;
      return "Couldn't reach the backup server. Try again.";
    }
    if (err instanceof PasskeyError)
      return err.code === "cancelled" ? "Cancelled." : `${biometricName()} didn't complete.`;
    return "Something went wrong. Try again.";
  }

  async function turnOn() {
    setNote(null);
    setBusy(true);
    try {
      let prf: { output: Uint8Array; credentialId: string } | null = null;
      let checked = false; // that assertion is the step-up the server asks for
      try {
        const assertion = await assertPasskeyWithPrf("step_up", prfSalt(userId));
        checked = true;
        unlocked(assertion.verifiedAt);
        if (assertion.prf && assertion.credentialId)
          prf = { output: assertion.prf, credentialId: assertion.credentialId };
      } catch (err) {
        if (err instanceof PasskeyError && err.code === "cancelled") throw err;
        // No PRF, or an unsupported browser: the recovery key alone protects the backup.
      }
      if (!checked && !(await stepUp.confirm("Turning on backup"))) return;
      const result = await enableBackup(db, userId, prf);
      await pushBackup(db, userId, engine.rulesVersion ?? "unknown", { force: true });
      backupUiState.lastRecoveryKey = result.recoveryKey;
      setRecovery(result.recoveryKey);
      setShowRecovery(true);
      await load();
    } catch (err) {
      setNote(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function backUpNow() {
    setNote(null);
    setBusy(true);
    try {
      const result = await pushBackup(db, userId, engine.rulesVersion ?? "unknown", {
        force: true,
      });
      setNote(result.uploaded ? "Backed up just now." : "Nothing new to back up.");
      await load();
    } catch (err) {
      setNote(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setConfirmOff(false);
    if (!(await stepUp.confirm("Turning off backup"))) return;
    setBusy(true);
    try {
      await disableBackup(db);
      setNote("Backup is off. Your data stays on this device.");
      await load();
    } catch (err) {
      setNote(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function restoreWithPrf() {
    if (!status?.key) return;
    setNote(null);
    setBusy(true);
    try {
      const assertion = await assertPasskeyWithPrf("step_up", prfSalt(userId));
      if (!assertion.prf) throw new BackupError("wrong_passkey", "no prf");
      const pulled = await restoreWithPasskey(db, userId, status.key, assertion.prf);
      setNote(restoredLine(pulled.report));
      await load();
    } catch (err) {
      setNote(explain(err));
    } finally {
      setBusy(false);
    }
  }

  async function restoreWithKey() {
    if (!status?.key) return;
    setNote(null);
    setBusy(true);
    try {
      const pulled = await restoreWithRecoveryKey(db, userId, status.key, recoveryInput);
      setRecoveryInput("");
      setNote(restoredLine(pulled.report));
      await load();
    } catch (err) {
      setNote(explain(err));
    } finally {
      setBusy(false);
    }
  }

  const lastBackup = status?.latest?.created_at ?? null;
  const lastLine = lastBackup
    ? `Last backup: ${shortDate(lastBackup)}, ${shortTime(lastBackup)}`
    : lastSync
      ? `Last checked ${shortDate(lastSync)}, ${shortTime(lastSync)}`
      : "No backup yet.";

  if (!entitlements.backup) {
    return (
      <section aria-labelledby="backup-h">
        <h2 className="section-title" id="backup-h">
          Encrypted backup
        </h2>
        <PlanLimit>
          Backup is part of Private and Connected: your data is encrypted on this device before
          upload, and we store only scrambled data we can't read. Until then, keep a copy with Me →
          Download all my data.
        </PlanLimit>
      </section>
    );
  }

  return (
    <section aria-labelledby="backup-h">
      <h2 className="section-title" id="backup-h">
        Encrypted backup
      </h2>
      <Card>
        {hasKey === null || status === null ? (
          <p className="sr-only">Loading backup status</p>
        ) : hasKey ? (
          <>
            <p>
              <strong>On.</strong> Encrypted on this device before upload. We store only scrambled
              data we can't read. {lastLine}
            </p>
            <div className="transfer-choice">
              <Button variant="secondary" onClick={backUpNow} disabled={busy}>
                Back up now
              </Button>
              <Button
                variant="secondary"
                onClick={() => setShowRecovery(true)}
                disabled={!recovery}
              >
                Save recovery key
              </Button>
            </div>
            <p className="auth__fineprint">
              If you lose your passkey and your recovery key, the backup can't be restored.
            </p>
            <Button variant="ghost" block onClick={() => setConfirmOff(true)} disabled={busy}>
              <span style={{ color: "var(--c-danger)" }}>Turn off backup</span>
            </Button>
          </>
        ) : status.enabled && status.key ? (
          <>
            <p>
              <strong>Restore on this device.</strong> Your backup is encrypted; unlock it with your{" "}
              {biometricName()} or the recovery key you saved. {lastLine}
            </p>
            {status.key.passkey_wrapped ? (
              <Button block onClick={restoreWithPrf} disabled={busy}>
                Unlock with {biometricName()}
              </Button>
            ) : null}
            <label className="auth__field">
              <span className="auth__label">Recovery key</span>
              <input
                className="auth__input"
                value={recoveryInput}
                onChange={(e) => setRecoveryInput(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <Button
              block
              variant="secondary"
              onClick={restoreWithKey}
              disabled={busy || !recoveryInput.trim()}
            >
              Unlock with the recovery key
            </Button>
          </>
        ) : (
          <>
            <p>
              <strong>Off.</strong> Turn it on to keep an encrypted copy of your data and sync it
              between your devices. It's encrypted on this device before upload; we store only
              scrambled data we can't read.
            </p>
            <Button block onClick={turnOn} disabled={busy}>
              Turn on encrypted backup
            </Button>
          </>
        )}
        {note ? (
          <p className="auth__hint" role="status">
            {note}
          </p>
        ) : null}
      </Card>
      {status?.devices.length ? (
        <List card aria-label="Devices that sync">
          {status.devices.map((d) => (
            <ListRow
              key={d.label}
              label={d.label}
              sublabel={`Last backup ${shortDate(d.last_backup_at)}, ${shortTime(d.last_backup_at)}`}
            />
          ))}
        </List>
      ) : null}
      <p className="auth__fineprint">
        Statement files and receipt photos stay on the device they were added on; everything else is
        in the backup. <Link to="/me/plan">Your plan</Link> includes backup.
      </p>

      <Sheet open={showRecovery} onClose={() => setShowRecovery(false)} title="Your recovery key">
        <p className="auth__hint">
          Write it down and keep it somewhere safe. It opens your backup on a new device when your{" "}
          {biometricName()} can't. We never see it.
        </p>
        <p className="invite-code" style={{ fontSize: "1.1rem", wordBreak: "break-all" }}>
          <span className="sr-only">Recovery key: </span>
          {recovery}
        </p>
        <Button
          block
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(recovery ?? "");
              setNote("Recovery key copied.");
            } catch {
              setNote("Couldn't copy. The key is above.");
            }
          }}
        >
          Copy
        </Button>
        <Button block onClick={() => setShowRecovery(false)}>
          I've saved it
        </Button>
      </Sheet>

      <Sheet open={confirmOff} onClose={() => setConfirmOff(false)} title="Turn off backup?">
        <ul className="auth__hint" style={{ paddingLeft: 20 }}>
          <li>Your backup and its key are deleted from our servers.</li>
          <li>This device keeps everything on it.</li>
          <li>Other devices stop syncing.</li>
        </ul>
        <Button block onClick={() => setConfirmOff(false)}>
          Keep backup on
        </Button>
        <Button block variant="ghost" onClick={turnOff}>
          <span style={{ color: "var(--c-danger)" }}>Turn off backup</span>
        </Button>
      </Sheet>
    </section>
  );
}

function restoredLine(report: { added: number; updated: number; removed: number } | null): string {
  if (!report) return "Unlocked. Nothing to restore yet; this device will back up from now on.";
  const n = report.added + report.updated;
  return `Restored ${n} ${n === 1 ? "item" : "items"}. This device now syncs.`;
}
