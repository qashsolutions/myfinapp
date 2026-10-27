import { formatCents } from "../../lib/format.ts";
import { ChoiceChips } from "../goals/CustomValueSheet.tsx";

/** Monthly savings challenge targets; the presets are proposed, not in the spec. */
export const TARGET_PRESETS = [10000, 25000, 50000, 100000];

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
}: {
  presets?: number[];
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
      <p className="auth__hint">Only you see this number. The group sees your percent.</p>
    </div>
  );
}
