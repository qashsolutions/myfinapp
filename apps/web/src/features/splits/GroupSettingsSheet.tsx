import { trimSpaces } from "@stackd/rules/text";
import { Button, Sheet } from "@stackd/ui";
import { useEffect, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { SplitMethod } from "../../engine/bridge.ts";
import { ChipsOrOwn } from "../goals/CustomValueSheet.tsx";
import { ChipChoice } from "./ChipChoice.tsx";
import type { GroupMeta } from "./ledger.ts";
import { valuesOf } from "./splitValues.ts";
import {
  GROUP_KINDS,
  MAX_NAME,
  METHODS,
  namesOf,
  ownKindText,
  parseOwnKind,
  type SplitGroupOut,
  saveGroupMeta,
} from "./useSplits.ts";

/**
 * The organizer changes a group after it starts (S.6, November 10, 2026): its name, what it's
 * for, the usual split with each person's percent or shares (a guest's bill follows it), and
 * who takes a leftover cent. All of it lives in the organizer's encrypted ledger.
 */
export function GroupSettingsSheet({
  group,
  meta,
  open,
  onClose,
  onSaved,
}: {
  group: SplitGroupOut;
  meta: GroupMeta | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { db } = useDb();
  const nameOf = namesOf(group);
  const live = group.members.map((m) => m.member_id);
  const liveKey = live.join(",");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("home");
  const [method, setMethod] = useState<SplitMethod>("equal");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [leftover, setLeftover] = useState<string>("payer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(meta?.name ?? "");
    setKind(meta?.kind ?? "home");
    setMethod(meta?.usual_method ?? "equal");
    const v = meta?.usual_values ?? {};
    setTyped(
      Object.fromEntries(
        Object.entries(v).map(([p, n]) => [
          p,
          meta?.usual_method === "shares" ? String(n) : (n / 100).toFixed(2),
        ]),
      ),
    );
    setLeftover(
      meta?.leftover && liveKey.split(",").includes(meta.leftover) ? meta.leftover : "payer",
    );
    setError(null);
  }, [open, meta, liveKey]);

  const perPerson = method === "percent" || method === "shares";
  const unit = method === "percent" ? "percent" : "shares";

  async function save() {
    const clean = trimSpaces(name);
    if (!clean) return setError("Give the group a name.");
    if (clean.length > MAX_NAME) return setError(`Keep it to ${MAX_NAME} characters.`);
    let values: Record<string, number> | null = null;
    if (perPerson) {
      const got = await valuesOf(method, live, typed);
      if (got === "bad" || got === null)
        return setError(
          method === "shares"
            ? "Each share needs a whole number from 1 to 1000."
            : "Give everyone a percent.",
        );
      if (method === "percent" && Object.values(got).reduce((a, b) => a + b, 0) !== 10000)
        return setError("The percents need to add up to 100.");
      values = got;
    }
    setBusy(true);
    const r = await saveGroupMeta(db, group, {
      name: clean,
      kind,
      usual_method: method,
      usual_values: values,
      leftover,
    });
    setBusy(false);
    if (!r.ok) return setError("Couldn't save. Try again when you're online.");
    await onSaved();
    onClose();
  }

  const leftoverOptions: ReadonlyArray<readonly [string, string]> = [
    ["payer", "Whoever paid"],
    ...live.map((id) => [id, nameOf(id)] as const),
  ];

  return (
    <Sheet open={open} onClose={onClose} title="Group settings">
      <label className="auth__field">
        <span className="auth__label">Group name</span>
        <input
          className="auth__input"
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <ChipsOrOwn
        key={kind}
        name="group-kind"
        legend="What's it for?"
        options={GROUP_KINDS}
        value={kind}
        onPick={setKind}
        display={ownKindText}
        own={{
          label: "Or name your own",
          placeholder: "Or name your own",
          inputMode: "text",
          parse: parseOwnKind,
        }}
      />
      <ChipChoice
        legend="Usually split"
        options={METHODS}
        value={method}
        onChange={(v) => setMethod(v)}
      />
      {perPerson ? (
        <fieldset className="split-people">
          <legend className="auth__label">
            {method === "percent" ? "Each person's percent" : "Each person's shares"}
          </legend>
          {live.map((p) => (
            <div className="split-person" key={p}>
              <span className="split-person__name">{nameOf(p)}</span>
              <input
                className="auth__input"
                inputMode={method === "shares" ? "numeric" : "decimal"}
                aria-label={`${nameOf(p)}, ${unit}`}
                value={typed[p] ?? ""}
                onChange={(e) => setTyped((t) => ({ ...t, [p]: e.target.value }))}
              />
            </div>
          ))}
        </fieldset>
      ) : null}
      <p className="auth__hint">
        {method === "exact"
          ? "Exact needs each bill's own amounts, so bills others add split equally."
          : "Bills others add follow this split, and wait for your OK."}
      </p>
      <ChipChoice
        legend="Who takes a leftover cent?"
        options={leftoverOptions}
        value={leftover}
        onChange={(v) => setLeftover(v)}
      />
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={save} disabled={busy}>
        Save
      </Button>
    </Sheet>
  );
}
