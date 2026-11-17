import { Button, Card } from "@stackd/ui";
import { Word } from "../../app/layout/Word.tsx";
import type { DocRow } from "./documentHistory.ts";

/**
 * "Same": this was added before (owner decision, November 16, 2026). Says when and what it
 * became, and lets the person keep what's there or add it anyway; nothing is added until they
 * choose. Adding a statement anyway never adds a transaction twice.
 */
export function AlreadyAdded({
  earlier,
  why,
  anywayNote,
  onKeep,
  onAnyway,
}: {
  earlier: DocRow;
  /** "This exact file" or "The same total" or "Every transaction in it". */
  why: string;
  anywayNote: string;
  onKeep: () => void;
  onAnyway: () => void;
}) {
  return (
    <Card as="section" aria-label="Same as before" className="doc-total">
      <Word>Same</Word>
      <p className="doc-total__line">
        {why} was added on {earlier.added}: <strong>{earlier.became}</strong>. Nothing new in this
        file.
      </p>
      <div className="doc-total__actions">
        <Button block onClick={onKeep}>
          Keep what's there
        </Button>
        <Button block variant="secondary" onClick={onAnyway}>
          Add it anyway
        </Button>
      </div>
      <p className="auth__fineprint">{anywayNote}</p>
    </Card>
  );
}
