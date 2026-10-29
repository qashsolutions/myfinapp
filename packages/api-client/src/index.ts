/**
 * @stackd/api-client: a typed fetch client for services/api.
 *
 * `openapi.json` is written by `stackd-api openapi` and `src/schema.ts` is generated from it
 * (`pnpm api:schema` at the repo root does both). CI fails if either is stale, so the client
 * can never drift from the server. Calls are same-origin (`/api/...`) with cookies.
 */

import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema.ts";

export type { components, paths } from "./schema.ts";

export interface ApiClientOptions {
  /** Defaults to "" (same origin). The dev server proxies /api to the API. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Called when the API answers 401 or 403 with a known reason (sign_in_required, locked, step_up_required). */
  onAuthSignal?: (signal: AuthSignal) => void;
  /** Headers sent with every call from this client (the web app's background client). */
  headers?: Record<string, string>;
}

export type AuthSignal = "sign_in_required" | "locked" | "step_up_required";

const AUTH_SIGNALS = new Set<string>(["sign_in_required", "locked", "step_up_required"]);

/** The server's `detail` for an error response, when it is one of the auth signals. */
export async function authSignalOf(response: Response): Promise<AuthSignal | null> {
  if (response.status !== 401 && response.status !== 403) return null;
  try {
    const body = (await response.clone().json()) as { detail?: unknown };
    return typeof body.detail === "string" && AUTH_SIGNALS.has(body.detail)
      ? (body.detail as AuthSignal)
      : null;
  } catch {
    return null;
  }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? "",
    credentials: "include",
    ...(options.headers ? { headers: options.headers } : {}),
    // Late-bound so a test can replace globalThis.fetch after the client exists.
    fetch: options.fetch ?? ((input: Request) => globalThis.fetch(input)),
  });
  // No network (offline, the server unreachable, DNS): answer with a status-0 response, the
  // shape every caller already reads with failureOf(), instead of throwing past it. A throw
  // left buttons pending for good and the session check loading forever (invariant 35,
  // October 29, 2026). A request the caller cancelled still throws, since nobody waits on it.
  client.use({
    onError({ error }) {
      if ((error as { name?: unknown } | null)?.name === "AbortError") return error as Error;
      return Response.error();
    },
  });
  if (options.onAuthSignal) {
    const onAuthSignal = options.onAuthSignal;
    const middleware: Middleware = {
      async onResponse({ response }) {
        const signal = await authSignalOf(response);
        if (signal) onAuthSignal(signal);
        return response;
      },
    };
    client.use(middleware);
  }
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
