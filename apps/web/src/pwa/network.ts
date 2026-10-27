/** Online / offline, as a subscribable value (jsdom and browsers both expose navigator.onLine). */

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

let watching = false;

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

export function onNetworkChange(listener: () => void): () => void {
  if (!watching && typeof window !== "undefined") {
    window.addEventListener("online", notify);
    window.addEventListener("offline", notify);
    watching = true;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
