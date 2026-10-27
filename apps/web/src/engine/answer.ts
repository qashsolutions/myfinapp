import { RULES_VERSION } from "@stackd/rules";
import { type EngineRequest, type EngineResponse, handle } from "@stackd/rules/engine";

/**
 * One call's answer, in the worker and inline alike. Bad input is the rule's own error code; any
 * other throw is a bug in one rule for one input, so that call fails (`engine_failed`) and the
 * engine keeps going: in the worker it never escapes as an error event, which would hand the rest
 * of the session to the main thread (October 27, 2026).
 */
export function answer(request: EngineRequest): EngineResponse {
  try {
    return handle(request);
  } catch {
    return { id: request.id, ok: false, error: "engine_failed", rules_version: RULES_VERSION };
  }
}
