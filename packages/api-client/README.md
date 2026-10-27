# @stackd/api-client

The typed client the PWA uses to talk to `services/api`. Nothing here is written by hand except `src/index.ts`.

| File | Source |
|---|---|
| `openapi.json` | `stackd-api openapi -o packages/api-client/openapi.json` (the FastAPI app's OpenAPI document) |
| `src/schema.ts` | `openapi-typescript openapi.json` (types for every path, request and response) |
| `src/index.ts` | `createApiClient()` on `openapi-fetch`: same-origin `/api/...`, cookies included, and an `onAuthSignal` hook for `sign_in_required`, `locked` and `step_up_required` |

```bash
pnpm api:schema            # from the repo root: regenerate both files after changing a router
pnpm -C packages/api-client test
```

CI fails when either file is stale (`stackd-api openapi --check -o packages/api-client/openapi.json` and a `git diff` after `generate`), so the client cannot drift from the server. Both files are generated output: Biome ignores them, so never format them by hand.

Usage:

```ts
import { createApiClient } from "@stackd/api-client";
const api = createApiClient({ onAuthSignal: (s) => console.log(s) });
const { data, error } = await api.POST("/api/auth/otp/send", { body: { email } });
```
