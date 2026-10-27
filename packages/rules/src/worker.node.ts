/** node:worker_threads entry with the same protocol as worker.ts; used by worker.test.ts. */

import { parentPort } from "node:worker_threads";

import { type EngineRequest, handle } from "./engine.ts";

if (!parentPort) throw new Error("worker.node.ts must run inside a Worker");
const port = parentPort;
port.on("message", (request: EngineRequest) => {
  port.postMessage(handle(request));
});
