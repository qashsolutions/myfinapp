/**
 * The worker message protocol, independent of any worker API so it can be tested in-process,
 * bound to a Web Worker (worker.ts) or to node:worker_threads (worker.node.ts).
 */

import { RuleError } from "./errors.ts";
import { type JsonObject, RULES } from "./registry.ts";
import { RULES_VERSION } from "./version.ts";

export interface EngineRequest {
  id: number;
  rule: string;
  input: JsonObject;
}

export type EngineResponse =
  | { id: number; ok: true; result: JsonObject; rules_version: string }
  | { id: number; ok: false; error: string; rules_version: string };

/** Run one rule. A RuleError becomes {ok: false, error: code}; anything else is rethrown. */
export function runRule(rule: string, input: JsonObject): JsonObject {
  const fn = RULES[rule];
  if (!fn) throw new TypeError(`unknown rule: ${rule}`);
  return fn(input);
}

export function handle(request: EngineRequest): EngineResponse {
  try {
    const result = runRule(request.rule, request.input);
    return { id: request.id, ok: true, result, rules_version: RULES_VERSION };
  } catch (e) {
    if (e instanceof RuleError) {
      return { id: request.id, ok: false, error: e.code, rules_version: RULES_VERSION };
    }
    throw e;
  }
}
