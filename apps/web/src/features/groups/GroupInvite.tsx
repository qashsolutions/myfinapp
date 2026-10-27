import { Button, Sheet } from "@stackd/ui";
import { useState } from "react";
import type { GroupDetail } from "../../data/api.ts";
import { isFailure, regenerateCode } from "./useGroups.ts";

/** Invite code and share link; the owner can issue a new code (the old one stops working). */
export function GroupInvite({
  group,
  open,
  onClose,
  onChanged,
}: {
  group: GroupDetail;
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState<string | null>(null);
  const link = `${globalThis.location?.origin ?? ""}/groups/join?code=${group.invite_code}`;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNote(`${what} copied.`);
    } catch {
      setNote(`Couldn't copy. The ${what.toLowerCase()} is above.`);
    }
  }

  async function share() {
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({
          title: group.name,
          text: `Join my savings challenge: ${group.name}`,
          url: link,
        });
        return;
      } catch {
        // cancelled: fall through to copying
      }
    }
    await copy(link, "Link");
  }

  return (
    <Sheet open={open} onClose={onClose} title="Invite friends">
      <p className="invite-code">
        <span className="sr-only">Invite code: </span>
        {group.invite_code}
      </p>
      <p className="auth__hint">
        Anyone with the code can join. They set their own target; you'll only ever see their
        percent.
      </p>
      <Button block onClick={() => copy(group.invite_code, "Code")}>
        Copy code
      </Button>
      <Button block variant="secondary" onClick={share}>
        Share link
      </Button>
      {group.is_owner ? (
        <Button
          block
          variant="ghost"
          onClick={async () => {
            const result = await regenerateCode(group.id);
            setNote(
              isFailure(result)
                ? "Couldn't make a new code."
                : "New code issued; the old one no longer works.",
            );
            await onChanged();
          }}
        >
          New invite code
        </Button>
      ) : null}
      {note ? (
        <p className="auth__hint" role="status">
          {note}
        </p>
      ) : null}
    </Sheet>
  );
}
