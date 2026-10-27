import { useLiveQuery } from "dexie-react-hooks";
import { KEY_SETTING } from "../../data/backup/sync.ts";
import { useDb } from "../../data/DbProvider.tsx";

/**
 * "Make Qash yours" (owner, October 20, 2026: onboarding as choices, not a wizard; every step is
 * the person's to take, in any order, or not at all). Each step is done when the thing exists,
 * so it reads the same wherever the person did it.
 */
export interface SetupStep {
  id: "money" | "pay" | "budget" | "jar" | "safe" | "home";
  title: string;
  line: string;
  to: string;
  done: boolean;
}

const DISMISSED = "onboarding.done";

export function useSetup(): { steps: SetupStep[]; left: number; dismissed: boolean } | undefined {
  const { db } = useDb();
  return useLiveQuery(async () => {
    const [entries, pay, budgets, goals, key, layout, dismissed] = await Promise.all([
      db.entries.count(),
      db.settings.get("pay"),
      db.budgets.count(),
      db.goals.filter((g) => g.status !== "archived" && !g.group_id).count(),
      db.settings.get(KEY_SETTING),
      db.settings.get("home.layout"),
      db.settings.get(DISMISSED),
    ]);
    const steps: SetupStep[] = [
      {
        id: "money",
        title: "Add your money",
        line: "Upload a statement, link a bank, or add as you go",
        to: "/import",
        done: entries > 0,
      },
      {
        id: "pay",
        title: "Your pay",
        line: "Turns on safe to spend and the 30-day view",
        to: "/budget",
        done: Boolean(pay),
      },
      {
        id: "budget",
        title: "Budget your way",
        line: "Start from 50/30/20, or give every dollar a job",
        to: "/budget",
        done: budgets > 0,
      },
      {
        id: "jar",
        title: "A jar of your own",
        line: "Save toward anything, at your pace",
        to: "/goals/new",
        done: goals > 0,
      },
      {
        id: "safe",
        title: "Keep your data safe",
        line: "An encrypted backup and a recovery key only you hold",
        to: "/me/security",
        done: Boolean(key),
      },
      {
        id: "home",
        title: "Arrange your Home",
        line: "Put the cards you care about first",
        to: "/?customize=1",
        done: Boolean(layout),
      },
    ];
    return {
      steps,
      left: steps.filter((s) => !s.done).length,
      dismissed: Boolean(dismissed?.value),
    };
  }, [db]);
}

export async function finishSetup(db: ReturnType<typeof useDb>["db"]): Promise<void> {
  await db.settings.put({ key: DISMISSED, value: true, updated_at: new Date().toISOString() });
}
