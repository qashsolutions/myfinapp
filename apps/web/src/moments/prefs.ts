/**
 * Sounds and Celebrations (Me → Display): this device's choice, like Dark mode. Both on by
 * default; confetti also stays off whenever the device asks for reduced motion.
 */
import { useSyncExternalStore } from "react";

const KEYS = { sounds: "stackd.sounds", celebrations: "stackd.celebrations" } as const;
type Pref = keyof typeof KEYS;

const listeners = new Set<() => void>();

function read(pref: Pref): boolean {
  try {
    return localStorage.getItem(KEYS[pref]) !== "0";
  } catch {
    return true;
  }
}

export function getMomentPref(pref: Pref): boolean {
  return read(pref);
}

export function setMomentPref(pref: Pref, on: boolean): void {
  try {
    localStorage.setItem(KEYS[pref], on ? "1" : "0");
  } catch {
    // private mode: the choice lasts for this page only
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useMomentPref(pref: Pref): boolean {
  return useSyncExternalStore(subscribe, () => read(pref));
}
