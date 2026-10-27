import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { PrivacyLegal } from "./PrivacyLegal.tsx";
import { AppVersion } from "./SettingsScreen.tsx";

/** Me → Help & legal. */
export function HelpSettings() {
  return (
    <>
      <ScreenHeader title="Help & legal" actions={null} back="/me" />
      <PrivacyLegal />
      <AppVersion />
    </>
  );
}
