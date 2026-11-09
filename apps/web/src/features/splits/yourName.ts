import { trimSpaces } from "@stackd/rules/text";
import { setDisplayName } from "../groups/useGroups.ts";

/** A split group shows people by name (spec "The invite card"); 1 to 40 characters. */
export const NAME_MAX = 40;

/** Save the name the group sees, when the account has none yet. Null when saved, else words. */
export async function saveYourName(typed: string): Promise<string | null> {
  const name = trimSpaces(typed);
  if (!name) return "Add your name, so the group knows who you are.";
  if (name.length > NAME_MAX) return `Keep your name to ${NAME_MAX} characters.`;
  const failure = await setDisplayName(name);
  return failure ? "Couldn't save your name. Try again when you're online." : null;
}
