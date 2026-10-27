import { Button, Chip, List, ListRow } from "@stackd/ui";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, type DeviceOut } from "../../data/api.ts";
import { shortDate, shortTime } from "../../lib/dates.ts";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "./StepUpPrompt.tsx";

const when = (iso: string) => `${shortDate(iso)}, ${shortTime(iso)}`;

/** One line under the device name: when it signed in, and how and when it ended. */
export function deviceLine(d: DeviceOut): string {
  const ended = d.ended_at ? when(d.ended_at) : "";
  switch (d.status) {
    case "current":
      return `This device · signed in ${when(d.created_at)}`;
    case "active":
      return `Signed in ${when(d.created_at)} · last active ${when(d.last_seen_at)}`;
    case "signed_out_remote":
      return `Signed out from another device ${ended}`;
    case "expired":
      return `Session expired ${ended}`;
    default:
      return `Signed out ${ended}`;
  }
}

const STATUS_CHIP: Record<string, { text: string; tone: "accent" | "success" | "neutral" }> = {
  current: { text: "Current", tone: "accent" },
  active: { text: "Active", tone: "success" },
  signed_out: { text: "Signed out", tone: "neutral" },
  signed_out_remote: { text: "Signed out", tone: "neutral" },
  expired: { text: "Expired", tone: "neutral" },
};

/**
 * Settings → Sign-in & security → Devices (mockup F6Security, October 13, 2026): every device
 * signed in now, each with its sign-in time and a Sign out, then sessions that ended in the
 * last 30 days with how and when. No IP addresses: the server keeps only keyed hashes.
 */
export function ActiveDevices() {
  const session = useSession();
  const stepUp = useStepUp();
  const navigate = useNavigate();
  const [items, setItems] = useState<DeviceOut[] | null>(null);

  const load = useCallback(async () => {
    const { data } = await api.GET("/api/security/devices");
    if (data) setItems(data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function signOut(d: DeviceOut) {
    if (!(await stepUp.confirm("Signing out a device"))) return;
    await api.DELETE("/api/security/devices/{session_id}", {
      params: { path: { session_id: d.id } },
    });
    if (d.current) {
      await session.signOut();
      navigate("/welcome", { replace: true });
      return;
    }
    await load();
  }

  const live = (items ?? []).filter((d) => d.status === "current" || d.status === "active");
  const ended = (items ?? []).filter((d) => d.status !== "current" && d.status !== "active");
  const row = (d: DeviceOut) => {
    const chip = STATUS_CHIP[d.status ?? "active"] ?? STATUS_CHIP.active;
    return (
      <ListRow
        key={d.id}
        label={d.label}
        sublabel={deviceLine(d)}
        value={
          d.status === "active" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => signOut(d)}
              aria-label={`Sign out ${d.label}`}
            >
              <span style={{ color: "var(--c-danger)" }}>Sign out</span>
            </Button>
          ) : (
            <Chip tone={chip?.tone}>{chip?.text}</Chip>
          )
        }
      />
    );
  };

  return (
    <section aria-labelledby="devices-h">
      <h2 className="section-title" id="devices-h">
        Signed-in devices
      </h2>
      <List card aria-label="Signed in now">
        {live.map(row)}
      </List>
      {ended.length > 0 ? (
        <>
          <h3 className="section-subtitle" id="ended-h">
            Ended in the last 30 days
          </h3>
          <List card aria-labelledby="ended-h">
            {ended.map(row)}
          </List>
        </>
      ) : null}
    </section>
  );
}
