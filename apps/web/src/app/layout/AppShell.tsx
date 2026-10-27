import "./shell.css";

import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";
import { UndoToast } from "../../features/entries/UndoToast.tsx";
import { HouseholdSync } from "../../features/household/useHousehold.ts";
import { LinkedSync } from "../../features/linking/LinkedSync.tsx";
import { AlertScheduleSync } from "../../features/notifications/useAlertSchedule.ts";
import { InstallOffer } from "../../features/pwa/InstallOffer.tsx";
import { OfflineBanner } from "../../features/pwa/OfflineBanner.tsx";
import { PullToRefresh } from "../../features/pwa/PullToRefresh.tsx";
import { UpdateToast } from "../../features/pwa/UpdateToast.tsx";
import { BackupSync } from "../../features/security/BackupSync.tsx";
import { PasskeyHereOffer } from "../../features/security/PasskeyHereOffer.tsx";
import { BringBackOffer } from "../../features/settings/KeptOnPhone.tsx";
import { LookSync } from "../../features/settings/LookSync.tsx";
import { useMediaQuery, WIDE_QUERY } from "../../lib/useMediaQuery.ts";
import { MomentsHost } from "../../moments/MomentsHost.tsx";
import { SpendingWatch } from "../../moments/SpendingWatch.tsx";
import { CrashScreen } from "../CrashScreen.tsx";
import { SideRail } from "./SideRail.tsx";
import { TabBar } from "./TabBar.tsx";

/**
 * The frame around every screen: skip link, one primary navigation (tab bar on phones,
 * side rail from 900px), and <main> that takes focus after each navigation so keyboard
 * and screen-reader users land on the new screen.
 */
export function AppShell() {
  const wide = useMediaQuery(WIDE_QUERY);
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {wide ? <SideRail /> : null}
      <main id="main" className="shell__main" tabIndex={-1} ref={main}>
        <OfflineBanner />
        <CrashScreen key={pathname}>
          <Outlet />
        </CrashScreen>
      </main>
      {wide ? null : <TabBar />}
      <UpdateToast />
      <PullToRefresh />
      <InstallOffer />
      <PasskeyHereOffer />
      <BringBackOffer />
      <AlertScheduleSync />
      <LookSync />
      <BackupSync />
      <HouseholdSync />
      <LinkedSync />
      <MomentsHost />
      <UndoToast />
      <SpendingWatch />
    </div>
  );
}
