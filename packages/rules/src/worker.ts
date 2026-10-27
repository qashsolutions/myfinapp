/** Browser Web Worker entry: new Worker(new URL("./worker.ts", import.meta.url), {type: "module"}). */

import { type EngineRequest, handle } from "./engine.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (event: MessageEvent<EngineRequest>) => {
  scope.postMessage(handle(event.data));
};
