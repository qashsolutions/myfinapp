# Golden fixtures

One directory per registered rule (`registry.RULES` key). Each case is a pair:

- `<case>.input.json`: the JSON object passed as keyword arguments.
- `<case>.expected.json`: the exact JSON the rule must return, or `{"error": "<code>"}`.

Expected values are derived by hand from `docs/spec.md`, never by running the code under test. The TypeScript engine port (chunk 0.6) runs these same files from `apps/web/tests/engine/`.
