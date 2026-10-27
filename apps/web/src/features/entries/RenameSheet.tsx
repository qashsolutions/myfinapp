import "../auth/auth.css";

import { Button, Sheet, Toggle } from "@stackd/ui";
import { useEffect, useId, useState } from "react";
import { useDb } from "../../data/DbProvider.tsx";
import type { Entry } from "../../data/db.ts";
import { likeThis, renameEntry } from "./entryActions.ts";

/** Rename an entry, and offer every entry with the same bank text (kept for future imports). */
export function RenameSheet({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const { db } = useDb();
  const ids = useId();
  const [name, setName] = useState("");
  const [others, setOthers] = useState(0);
  const [all, setAll] = useState(true);
  useEffect(() => {
    if (!entry) return;
    setName(entry.merchant);
    setAll(true);
    let alive = true;
    void likeThis(db, entry).then((rows) => {
      if (alive) setOthers(rows.length);
    });
    return () => {
      alive = false;
    };
  }, [db, entry]);
  if (!entry) return null;
  return (
    <Sheet open onClose={onClose} title="Rename">
      <label className="auth__field" htmlFor={`${ids}-name`}>
        <span className="auth__label">Name</span>
        <input
          id={`${ids}-name`}
          className="auth__input"
          value={name}
          maxLength={60}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {entry.raw_description && entry.raw_description !== name ? (
        <p className="auth__fineprint">Your bank calls it “{entry.raw_description}”.</p>
      ) : null}
      {others > 0 ? (
        <Toggle
          label={`Rename all ${others + 1} like this`}
          description="Future statements and bank updates use this name too"
          checked={all}
          onChange={setAll}
        />
      ) : null}
      <Button
        block
        disabled={!name.trim()}
        onClick={async () => {
          await renameEntry(db, entry, name, others > 0 && all);
          onClose();
        }}
      >
        Save
      </Button>
    </Sheet>
  );
}
