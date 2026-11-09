import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { useSplitGuest } from "./guest.ts";
import { SplitsTab } from "./SplitsTab.tsx";

/** /splits: a guest's first tab (spec "Guests"); everyone else also has it under Goals. */
export function SplitsHome() {
  const guest = useSplitGuest();
  return (
    <>
      <ScreenHeader title="Splits" actions={null} back={guest ? undefined : "/goals"} />
      <SplitsTab />
    </>
  );
}
