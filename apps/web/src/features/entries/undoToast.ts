import { useSyncExternalStore } from "react";

/** One short "done · Undo" message at a time, shown by UndoToast in the shell. */
export interface UndoMessage {
  id: number;
  text: string;
  undo: () => void;
}

let current: UndoMessage | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function showUndo(text: string, undo: () => void, ms = 6000): void {
  seq += 1;
  current = { id: seq, text, undo };
  if (timer) clearTimeout(timer);
  timer = setTimeout(dismissUndo, ms);
  emit();
}

export function dismissUndo(): void {
  current = null;
  if (timer) clearTimeout(timer);
  timer = null;
  emit();
}

export function useUndoMessage(): UndoMessage | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
