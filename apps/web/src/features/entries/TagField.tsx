import { useId, useState } from "react";
import { addTag, MAX_TAGS, suggestTags } from "./tags.ts";

/**
 * Tags on an entry: the chosen ones as chips to remove, a box to type a new one (Enter or a comma
 * adds it) and the person's earlier tags offered as they type, so "Hawaii trip" stays one tag.
 */
export function TagField({
  tags,
  known,
  onChange,
}: {
  tags: string[];
  known: string[];
  onChange: (tags: string[]) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const full = tags.length >= MAX_TAGS;
  const offers = text || tags.length === 0 ? suggestTags(known, text, tags) : [];

  function commit(value: string) {
    const next = addTag(tags, value);
    if (next !== tags) onChange(next);
    setText("");
  }

  return (
    <div className="field tag-field">
      <label className="field__label" htmlFor={id}>
        Tags
      </label>
      {tags.length ? (
        <ul className="tag-field__chosen" aria-label="Tags on this entry">
          {tags.map((t) => (
            <li key={t} className="tag-chip">
              <span>#{t}</span>
              <button
                type="button"
                className="tag-chip__remove"
                aria-label={`Remove tag ${t}`}
                onClick={() => onChange(tags.filter((x) => x !== t))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        id={id}
        className="field__input"
        placeholder={full ? `Up to ${MAX_TAGS} tags` : "Add a tag, like Hawaii trip"}
        disabled={full}
        value={text}
        enterKeyHint="done"
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) commit(v.slice(0, -1));
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (text.trim()) commit(text);
          }
        }}
        onBlur={() => {
          if (text.trim()) commit(text);
        }}
      />
      {offers.length && !full ? (
        <fieldset className="tag-field__offers">
          <legend className="sr-only">Your tags</legend>
          {offers.map((t) => (
            <button
              type="button"
              key={t}
              className="tag-chip tag-chip--offer"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(t)}
            >
              + #{t}
            </button>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
