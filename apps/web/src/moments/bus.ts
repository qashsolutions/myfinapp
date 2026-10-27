/**
 * Moments: something worth marking happened. Callers `emitMoment` right where the thing
 * happens (a deposit is saved, a check-in logged); `MomentsHost` in the app shell shows the
 * toast and plays the effects. Kept outside React so plain async functions can emit.
 */
import type { MomentType, Vars } from "./catalog.ts";

export interface Moment {
  type: MomentType;
  vars: Vars;
  /** Picks the variant: the event's own id (a goal event, an entry), so it is stable. */
  seed: string;
}

type Listener = (m: Moment) => void;
const listeners = new Set<Listener>();

/** Every moment emitted, newest last: read by tests, never sent anywhere. */
export const momentsLog: Moment[] = [];

export function emitMoment(type: MomentType, vars: Vars, seed: string): void {
  const m: Moment = { type, vars, seed };
  momentsLog.push(m);
  if (momentsLog.length > 50) momentsLog.shift();
  for (const l of listeners) l(m);
}

export function onMoment(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
