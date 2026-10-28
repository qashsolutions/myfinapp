import { Button } from "@stackd/ui";
import { useState } from "react";
import { parseAmount } from "../../engine/bridge.ts";
import { formatCents } from "../../lib/format.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";

/** Monthly savings challenge targets (owner sign-off, October 27, 2026); any amount is allowed. */
export const TARGET_PRESETS = [10000, 25000, 50000, 100000];

/** 1 + 2 + … + 52: a step-up 52-week plan saves this many steps in all. */
export const STEPS_IN_52_WEEKS = 1378;

/**
 * "Your target this month": preset chips or any amount. The amount is private to this device;
 * only the percent reached goes to the group. The parent parses `custom` through the engine.
 */
export function TargetField({
  name,
  value,
  onPick,
  custom,
  onCustom,
  presets = TARGET_PRESETS,
  label = "Your target this month",
  weeklyStep = false,
}: {
  presets?: number[];
  /** 52-week saving: also offer "step up by $X each week" (week n saves n × X). */
  weeklyStep?: boolean;
  label?: string;
  name: string;
  value: number;
  onPick: (cents: number) => void;
  custom: string;
  onCustom: (text: string) => void;
}) {
  return (
    <div className="auth__field">
      <span className="auth__label">{label}</span>
      <ChoiceChips
        name={name}
        options={presets.map((c) => [String(c), formatCents(c)])}
        value={custom.trim() ? "" : String(value)}
        onPick={(v) => {
          onCustom("");
          onPick(Number(v));
        }}
      />
      <label className="auth__field">
        <span className="auth__label">Or any amount</span>
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="300"
          value={custom}
          onChange={(e) => onCustom(e.target.value)}
        />
      </label>
      {weeklyStep ? (
        <StepUp
          onTotal={(cents) => {
            onCustom("");
            onPick(cents);
          }}
        />
      ) : null}
      <p className="auth__hint">Only you see this number. The group sees your percent.</p>
    </div>
  );
}

/** "Step up by $X each week": week 1 saves X, week 52 saves 52 × X, 1,378 × X in all. */
function StepUp({ onTotal }: { onTotal: (cents: number) => void }) {
  const [text, setText] = useState("");
  const [line, setLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function use() {
    setError(null);
    try {
      const step = await parseAmount(text);
      if (step <= 0) throw new Error("not positive");
      const total = step * STEPS_IN_52_WEEKS;
      if (!Number.isSafeInteger(total)) throw new Error("too large");
      onTotal(total);
      setLine(
        `Week 1: ${formatCents(step)} · week 52: ${formatCents(step * 52)} · ${formatCents(total)} in all`,
      );
    } catch {
      setLine(null);
      setError("Enter an amount like 5 or 2.50.");
    }
  }
  return (
    <div className="auth__field">
      <span className="auth__label">Or step up each week by</span>
      <div className="own-choice__row">
        <input
          className="auth__input"
          inputMode="decimal"
          placeholder="1"
          aria-label="Step up each week by"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <Button variant="secondary" size="sm" onClick={() => void use()} disabled={!text.trim()}>
          Use
        </Button>
      </div>
      {line ? (
        <p className="auth__hint" role="status">
          {line}
        </p>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
