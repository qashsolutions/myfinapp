import { useSyncExternalStore } from "react";

/** Whether the search sheet is open; the header button, the rail and the shortcut all open it. */
let open = false;
const listeners = new Set<() => void>();

function set(value: boolean) {
  if (open === value) return;
  open = value;
  for (const l of listeners) l();
}

export const openSearch = () => set(true);
export const closeSearch = () => set(false);

export function useSearchOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}
