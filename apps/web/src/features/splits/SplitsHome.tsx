import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { SplitsTab } from "./SplitsTab.tsx";

/** /splits: the Splits tab (owner decision, November 11, 2026), a guest's first tab too. */
export function SplitsHome() {
  return (
    <>
      <ScreenHeader title="Splits" actions={null} />
      <SplitsTab />
    </>
  );
}
