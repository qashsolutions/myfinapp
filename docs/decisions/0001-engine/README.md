# Chunk 0.6 engine prototype

Standalone measurement harness (not a workspace package). It bundles the TypeScript port, loads Pyodide on a worker thread with the Python package installed from source, runs every golden case through both, and records sizes and timings in `results.md`.

```bash
cd docs/decisions/0001-engine
pnpm install --ignore-workspace
node measure.mjs
```

Node ≥ 24 (runs `.ts` directly via type stripping). The decision this informed is in `../0001-engine.md`.
