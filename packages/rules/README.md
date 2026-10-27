# @stackd/rules

The TypeScript port of `services/rules/stackd_rules`, for running the rules on the device. **Python is the source of truth.** This package exists only because the golden tests prove it produces identical output; see `docs/decisions/0001-engine.md`.

Rules of the port:

- Same registry keys, same input and output JSON, same `RuleError` codes. `RULES_VERSION` is read from the Python package at test time and must match `src/version.ts`.
- Every rule added to Python is added here in the same change, after its golden cases exist. `golden.test.ts` fails if a registry key is missing on either side.
- Integer arithmetic only: `roundDiv` uses BigInt, `parseAmount` works on digit strings. No floating point touches money.
- Dates use `Date.UTC` day numbers, never local time.
- Runs anywhere: no DOM, no Node APIs in `src/` except the test files and the worker_threads adapter.

```bash
pnpm test        # same fixtures as services/rules/tests/golden, in-process and through a worker
pnpm typecheck
```

`engine.ts` is the message protocol (`{id, rule, input}` → `{id, result}` or `{id, error}`); `worker.ts` binds it to a browser Web Worker; `worker.node.ts` binds it to `node:worker_threads` for tests.
