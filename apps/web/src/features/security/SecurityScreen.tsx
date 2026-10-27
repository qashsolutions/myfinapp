import "./security.css";

import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { biometricName } from "../../lib/platform.ts";
import { ActiveDevices } from "./ActiveDevices.tsx";
import { AutoLockSetting } from "./AutoLockSetting.tsx";
import { BackupSettings } from "./BackupSettings.tsx";
import { ManagePasskeys } from "./ManagePasskeys.tsx";
import { RecentActivity } from "./RecentActivity.tsx";

/** Me → Sign-in & security ("Security & backup" in mockup F6Security). */
export function SecurityScreen() {
  return (
    <>
      <ScreenHeader title="Security & backup" actions={null} back="/me" />
      <BackupSettings />
      <ManagePasskeys />
      <AutoLockSetting />
      <ActiveDevices />
      <RecentActivity />
      <p className="auth__fineprint">
        Removing a passkey, signing out a device or changing the auto-lock needs a quick{" "}
        {biometricName()} check.
      </p>
    </>
  );
}
