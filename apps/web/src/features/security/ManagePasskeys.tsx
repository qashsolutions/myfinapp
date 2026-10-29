import { Button, List, ListRow } from "@stackd/ui";
import { useCallback, useEffect, useState } from "react";
import { api, failureOf, failureText, type PasskeyOut } from "../../data/api.ts";
import { shortDate } from "../../lib/dates.ts";
import { useSession } from "../auth/useSession.tsx";
import { useStepUp } from "./StepUpPrompt.tsx";
import { PasskeyError, registerPasskey } from "./webauthn.ts";

/** Settings → Sign-in & security → Passkeys (mockup F6Security). */
export function ManagePasskeys() {
  const session = useSession();
  const stepUp = useStepUp();
  const [items, setItems] = useState<PasskeyOut[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await api.GET("/api/security/passkeys");
    if (data) setItems(data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(p: PasskeyOut) {
    setNotice(null);
    if (items && items.length <= 1) {
      setNotice("Keep at least one passkey. Add another before removing this one.");
      return;
    }
    if (!(await stepUp.confirm("Removing a passkey"))) return;
    const result = await api.DELETE("/api/security/passkeys/{passkey_id}", {
      params: { path: { passkey_id: p.id } },
    });
    const failure = failureOf(result);
    if (failure?.code === "last_passkey")
      setNotice("Keep at least one passkey. Add another before removing this one.");
    else if (failure) setNotice(failureText(failure, "Couldn't remove that passkey. Try again."));
    await load();
  }

  async function add() {
    setNotice(null);
    if (!(await stepUp.confirm("Adding a passkey"))) return;
    try {
      await registerPasskey();
      await session.refresh();
      await load();
    } catch (err) {
      const e = err instanceof PasskeyError ? err : null;
      if (e?.code !== "cancelled") setNotice(e?.message ?? "Couldn't add a passkey.");
    }
  }

  return (
    <section aria-labelledby="passkeys-h">
      <h2 className="section-title" id="passkeys-h">
        Passkeys
      </h2>
      <List card>
        {(items ?? []).map((p) => (
          <ListRow
            key={p.id}
            label={p.label}
            sublabel={`Created ${shortDate(p.created_at)}${p.last_used_at ? ` · used ${shortDate(p.last_used_at)}` : ""}`}
            value={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(p)}
                aria-label={`Remove ${p.label}`}
              >
                <span style={{ color: "var(--c-danger)" }}>Remove</span>
              </Button>
            }
          />
        ))}
        <li className="sk-list__item">
          <Button variant="ghost" onClick={add}>
            + Add a passkey
          </Button>
        </li>
      </List>
      {items && items.length === 1 ? (
        <p className="insight__kind">
          Add a second passkey, on another device or a security key, so losing this one never locks
          you out.
        </p>
      ) : null}
      {notice ? (
        <p className="auth__hint" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
