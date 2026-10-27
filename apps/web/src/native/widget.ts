/**
 * The home-screen widget (Phase 2, chunk 2.3; spec `widget/`). The shells register a
 * `StackdWidget` plugin that writes the summary into the app group / shared preferences and
 * reloads the widget timeline; apps/mobile/README.md carries the contract. Everything stays on
 * the device: the strings handed over are the ones Home already shows, and outside a shell
 * this is a no-op.
 */

import { nativePlugin } from "../lib/platform.ts";

export interface WidgetSummary {
  month: string; // "October"
  got: string; // "$1,500.00", formatted by lib/format.ts like the Home hero
  spent: string;
  kept: string;
}

interface StackdWidgetPlugin {
  setSummary(summary: WidgetSummary): Promise<void>;
}

export async function publishWidgetSummary(summary: WidgetSummary): Promise<void> {
  const plugin = nativePlugin<StackdWidgetPlugin>("StackdWidget");
  if (!plugin) return;
  try {
    await plugin.setSummary(summary);
  } catch {
    /* the widget is cosmetic; never let it break Home */
  }
}
