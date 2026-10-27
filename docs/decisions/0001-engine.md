# 0001. On-device rules engine: TypeScript port; Python stays the source of truth

Date: 2026-10-09 · Status: accepted · Chunk: 0.6

## Context

The spec requires all money math to run on the user's device in a Web Worker, from one versioned rules package. It offers two ways: run the Python `stackd_rules` package itself via Pyodide (WebAssembly), or ship a TypeScript port that must pass the identical golden tests. Chunk 0.6 decides after a prototype that measures download size and speed, with the decision due by the end of build week 1.

The prototype is in `0001-engine/` (`measure.mjs`, reproducible with `pnpm install --ignore-workspace && node measure.mjs`). It bundles the port, loads Pyodide on a worker thread with the Python package installed from source, and runs every golden case through both. Full output: `0001-engine/results.md`.

| | TypeScript port (`packages/rules`) | Pyodide 314.0.7 running `services/rules` |
|---|---|---|
| Golden cases passing | 106 / 106 | 106 / 106 |
| Download before first rule runs | 6.0 KB raw · 2.4 KB gzip · 2.2 KB brotli | 11.7 MB raw · 5.8 MB gzip · 5.0 MB brotli |
| Start-up (Apple Silicon desktop, Node 25) | 61 ms module import | 1,371 ms runtime load + 49 ms package import |
| Per rule call | 3 µs in-process | 18 µs inside Python, 37 µs round trip through the worker |

**Not measured on a phone.** The spec asks for a mid-range phone measurement; this prototype ran on a desktop. Desktop timings are a lower bound for a phone, not an estimate of it. The download-size gap is device-independent and on its own settles the question: a PWA that must work offline and install from a Home Screen cannot reasonably pay 5 MB and a multi-second cold start before showing "Kept this month".

## Decision

1. **The on-device engine is the TypeScript port, `@stackd/rules` in `packages/rules`.** Chunk 1.3's `apps/web/src/engine/` wraps `@stackd/rules/worker` in a Web Worker and exposes typed calls; it holds no rule logic.
2. **Python `services/rules/stackd_rules` remains the source of truth** and the server-side engine (weekly recap, notification evaluation). Every formula is written there first.
3. **Parity is enforced by CI, not by discipline.** Both packages run the same fixture directory, `services/rules/tests/golden`. The TypeScript tests also assert that the registry key set equals the set of golden directories and that `RULES_VERSION` matches the Python package. A rule that exists on one side only fails CI.
4. **Adding or changing a rule** is one pull request in this order: formula in `docs/spec.md` → golden cases (expected values by hand) → Python → TypeScript → `RULES_VERSION` bump if any output changed.
5. **The port never uses floating point for money.** Division rounds half-even via BigInt; amount parsing works on digit strings; dates are UTC day numbers. Any construct the Python side has that JavaScript cannot mirror exactly is removed from Python instead (the port already forced one such change: `\d` in Python regexes admits Unicode digits, JavaScript's does not, so both now use `[0-9]`).

## Consequences

- Two implementations of every rule. Accepted: rules are small pure functions, the goldens catch drift, and the cost is bounded to the rules chunks.
- The port lives in `packages/rules` rather than the spec tree's `apps/web/src/engine/`, because it is a dependency-free library that the website or native shells may also use; `apps/web/src/engine/` becomes the worker wiring only.
- Nothing Python-only (pandas, Decimal beyond what the port mirrors) may enter the rules package. That was already policy; it is now load-bearing.
- The Web Worker binding (`packages/rules/src/worker.ts`) is exercised through `node:worker_threads` with the same message protocol in CI. The real browser worker gets its end-to-end test in chunk 1.3 and the Playwright suite in 1.15.
- The Pyodide harness stays in `0001-engine/` for reproducibility. It is not a workspace package and its dependencies are not installed by the monorepo.

Revisit if a rule genuinely needs a Python-only library, or if a phone measurement of the TypeScript worker ever shows start-up over one second.
