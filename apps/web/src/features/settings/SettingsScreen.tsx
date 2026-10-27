import "../auth/auth.css";
import "./settings.css";

import { Button, Card, List, ListRow } from "@stackd/ui";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";
import { APP_NAME } from "../../lib/brand.ts";
import { isStandalone } from "../../lib/platform.ts";
import { useSession } from "../auth/useSession.tsx";
import { summaryLine, useBilling } from "../billing/billing.ts";
import { parseEntitlements } from "../billing/entitlements.ts";
import { InstallGuide } from "../pwa/InstallGuide.tsx";
import { GroupRows, SettingsSearch } from "./SettingsNav.tsx";

/** "Private trial", "Private · yearly", or "Your plan" while it loads. */
export function usePlanLine(): { title: string; detail: string } {
  const { billing } = useBilling();
  if (!billing) return { title: "Your plan", detail: "Prices, receipts, cancel" };
  const trial = parseEntitlements(billing.entitlements)?.access?.state === "trial";
  return {
    title: trial
      ? `${billing.label} trial`
      : `${billing.label}${billing.interval ? ` · ${billing.interval}` : ""}`,
    detail: summaryLine(billing),
  };
}

/**
 * The Me tab: search, who you are and your plan (Account & plan), then one row per group, each
 * its own screen. Log out and Delete account stay here so deletion is two taps from Me
 * (spec hard constraint 5).
 */
export function SettingsScreen() {
  const session = useSession();
  const navigate = useNavigate();
  const [installOpen, setInstallOpen] = useState(false);
  const plan = usePlanLine();
  const email = session.info?.user?.email ?? "";
  const displayName = session.info?.user?.display_name ?? null;
  const initial = (displayName ?? email).charAt(0).toUpperCase();

  return (
    <>
      <ScreenHeader title="Me" actions={null} />
      <SettingsSearch>
        <List card aria-label="Account & plan">
          <ListRow
            leading={
              <span className="avatar" aria-hidden="true">
                {initial}
              </span>
            }
            label={displayName ?? email}
            sublabel={
              <>
                {displayName ? `${email} · ` : ""}
                {plan.title} · {plan.detail}
              </>
            }
            href="/me/account"
            onClick={(e) => {
              e.preventDefault();
              navigate("/me/account");
            }}
          />
        </List>
        {isStandalone() ? null : (
          <List card>
            <ListRow
              id="set-install"
              label={`Install ${APP_NAME}`}
              sublabel="Keeps your data safer and turns on alerts"
              onClick={() => setInstallOpen(true)}
              chevron
            />
          </List>
        )}
        <List card>
          <ListRow
            id="set-link-device"
            label="Link a device"
            sublabel="Sign in on a computer with this phone"
            href="/link"
            onClick={(e) => {
              e.preventDefault();
              navigate("/link");
            }}
            chevron
          />
        </List>
        <GroupRows skip="account" />
        <Card as="section" aria-label="Account" id="set-account">
          <Button
            variant="secondary"
            block
            onClick={async () => {
              await session.signOut();
              navigate("/welcome", { replace: true });
            }}
          >
            Log out
          </Button>
          <Button variant="ghost" block onClick={() => navigate("/me/delete")}>
            <span style={{ color: "var(--c-danger)" }}>Delete account</span>
          </Button>
        </Card>
        <AppVersion />
      </SettingsSearch>
      <InstallGuide open={installOpen} onClose={() => setInstallOpen(false)} />
    </>
  );
}

/** "Oct 18, 2026, 9:42 PM" in the viewer's own zone. */
function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function AppVersion() {
  return (
    <p className="auth__fineprint" title={`Build ${__BUILD_ID__}`}>
      {APP_NAME} Webapp v{import.meta.env.VITE_APP_VERSION ?? "1.0.0"}
      <br />
      Last updated {formatBuildTime(__BUILD_TIME__)}
      <br />
      Qash Solutions Inc.
    </p>
  );
}
