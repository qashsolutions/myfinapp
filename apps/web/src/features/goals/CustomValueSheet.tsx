import "../entries/entries.css";

import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";

/** The "Custom…" part of a blank (spec "Custom goals"): one input the engine validates. */
export interface CustomValue {
  label: string;
  placeholder?: string;
  type: "text" | "decimal" | "date";
  min?: string;
  max?: string;
  /** Validates through the engine and applies the value; resolves to a message to show instead, or null. */
  commit: (text: string) => Promise<string | null>;
}

/**
 * A blank's choice sheet (mockup F4Builder): preset chips, optionally "Or name your own" /
 * "Or any amount" / "Or pick a date", and one "Use this" button. A typed value wins over the
 * chips and only closes the sheet once the engine accepts it.
 */
export function CustomValueSheet({
  open,
  onClose,
  title,
  name,
  options,
  value,
  onPick,
  custom,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  name: string;
  options: Array<[string, string]>;
  value: string;
  onPick: (v: string) => void;
  custom?: CustomValue;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setText("");
    setError(null);
  }

  async function useThis() {
    if (custom && text.trim() !== "") {
      const message = await custom.commit(text);
      if (message) {
        setError(message);
        return;
      }
    }
    reset();
    onClose();
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={title}
    >
      <ChoiceChips
        name={name}
        options={options}
        value={value}
        onPick={(v) => {
          reset();
          onPick(v);
        }}
      />
      {custom ? (
        <label className="auth__field">
          <span className="auth__label">{custom.label}</span>
          <input
            className="auth__input"
            type={custom.type === "date" ? "date" : "text"}
            inputMode={custom.type === "decimal" ? "decimal" : undefined}
            min={custom.min}
            max={custom.max}
            placeholder={custom.placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </label>
      ) : null}
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      <Button block onClick={useThis}>
        Use this
      </Button>
    </Sheet>
  );
}

export function ChoiceChips({
  name,
  options,
  value,
  onPick,
}: {
  name: string;
  options: Array<[string, string]>;
  value: string;
  onPick: (v: string) => void;
}) {
  return (
    <fieldset className="chips" style={{ border: 0, margin: 0, padding: "4px 0 12px" }}>
      <legend className="sr-only">Choices</legend>
      {options.map(([v, label]) => (
        <label className="chip-option" key={v}>
          <input
            className="segmented__input"
            type="radio"
            name={name}
            value={v}
            checked={value === v}
            onChange={() => onPick(v)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Suggested chips plus the person's own value (owner, October 27, 2026): the chips are
 * suggestions, the box takes anything `parse` accepts. A value that matches no chip shows in
 * the box, so a saved own value is never hidden.
 */
export function ChipsOrOwn({
  name,
  legend,
  options,
  value,
  onPick,
  own,
  display = (v) => v,
}: {
  name: string;
  legend: string;
  options: Array<[string, string]>;
  value: string;
  onPick: (v: string) => void;
  /** How a saved value that matches no chip reads in the box (e.g. "10%, 50%" for "1000,5000"). */
  display?: (value: string) => string;
  own: {
    label: string;
    placeholder?: string;
    inputMode?: "numeric" | "decimal" | "text";
    type?: "text" | "date";
    min?: string;
    max?: string;
    /** Returns the value to pick, or a message to show. */
    parse: (text: string) => { value: string } | { error: string };
  };
}) {
  const known = options.some(([v]) => v === value);
  // Nothing chosen yet is an empty box, never `display("")` (which read "0%" for milestones).
  const [text, setText] = useState(known || value === "" ? "" : display(value));
  const [error, setError] = useState<string | null>(null);
  function use() {
    const r = own.parse(text);
    if ("error" in r) {
      setError(r.error);
      return;
    }
    setError(null);
    onPick(r.value);
  }
  return (
    <div className="own-choice">
      <p className="auth__label">{legend}</p>
      <ChoiceChips
        name={name}
        options={options}
        value={value}
        onPick={(v) => {
          setText("");
          setError(null);
          onPick(v);
        }}
      />
      <div className="own-choice__row">
        <input
          className="auth__input"
          type={own.type ?? "text"}
          inputMode={own.type === "date" ? undefined : (own.inputMode ?? "numeric")}
          min={own.min}
          max={own.max}
          placeholder={own.placeholder}
          aria-label={own.label}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") use();
          }}
        />
        <Button variant="secondary" size="sm" onClick={use} disabled={text.trim() === ""}>
          Use
        </Button>
      </div>
      {error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
