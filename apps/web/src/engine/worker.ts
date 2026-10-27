/// <reference lib="webworker" />
/**
 * The on-device rules engine, off the main thread. Same registry, same golden tests as the
 * Python source of truth (ADR 0001). bridge.ts talks to it.
 */

import type { EngineRequest } from "@stackd/rules/engine";
import { answer } from "./answer.ts";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<EngineRequest>) => {
  self.postMessage(answer(event.data));
};
