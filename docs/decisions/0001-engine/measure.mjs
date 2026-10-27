// Chunk 0.6: measure both on-device engine candidates against the shared golden fixtures.
// Writes results.md next to this file. Pure measurement; the decision is in ../0001-engine.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const here = fileURLToPath(new URL("./", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const goldenDir = join(repo, "services/rules/tests/golden");
const pySrcDir = join(repo, "services/rules/stackd_rules");
const tsEntry = join(repo, "packages/rules/src/engine.ts");

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
const fmtBytes = (n) => (n >= 1024 * 1024 ? mb(n) : kb(n));
const compressed = (buf) => ({
  raw: buf.length,
  gzip: gzipSync(buf, { level: 9 }).length,
  brotli: brotliCompressSync(buf, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
  }).length,
});

// ---- golden cases --------------------------------------------------------------------------
const cases = [];
for (const rule of readdirSync(goldenDir, { withFileTypes: true })) {
  if (!rule.isDirectory()) continue;
  const dir = join(goldenDir, rule.name);
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".input.json")) continue;
    const name = file.slice(0, -".input.json".length);
    cases.push({
      rule: rule.name,
      name,
      input: JSON.parse(readFileSync(join(dir, file), "utf8")),
      expected: JSON.parse(readFileSync(join(dir, `${name}.expected.json`), "utf8")),
    });
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log(`${cases.length} golden cases`);

// ---- TypeScript port: bundle size ---------------------------------------------------------
const outDir = mkdtempSync(join(tmpdir(), "stackd-engine-"));
const bundle = join(outDir, "engine.js");
const esb = spawnSync(
  "pnpm",
  ["dlx", "esbuild@0.28.2", tsEntry, "--bundle", "--minify", "--format=esm", "--target=es2022", `--outfile=${bundle}`],
  { cwd: outDir, encoding: "utf8" },
);
if (esb.status !== 0) {
  console.error(esb.stdout, esb.stderr);
  throw new Error("esbuild failed");
}
const tsSize = compressed(readFileSync(bundle));
console.log(`TS port bundle: ${fmtBytes(tsSize.raw)} raw, ${fmtBytes(tsSize.gzip)} gzip, ${fmtBytes(tsSize.brotli)} brotli`);

// ---- TypeScript port: correctness + speed (in-process, Node type stripping) -----------------
const tsT0 = performance.now();
const { handle } = await import(tsEntry);
const tsImportMs = performance.now() - tsT0;
let tsPass = 0;
for (const c of cases) {
  const r = handle({ id: 0, rule: c.rule, input: c.input });
  if (same(r.ok ? r.result : { error: r.error }, c.expected)) tsPass += 1;
}
const TS_ROUNDS = 200;
const tsRun0 = performance.now();
for (let i = 0; i < TS_ROUNDS; i++) for (const c of cases) handle({ id: 0, rule: c.rule, input: c.input });
const tsPerCallUs = ((performance.now() - tsRun0) * 1000) / (TS_ROUNDS * cases.length);
console.log(`TS port: ${tsPass}/${cases.length} pass, import ${tsImportMs.toFixed(1)} ms, ${tsPerCallUs.toFixed(1)} us/call`);

// ---- Pyodide: artifact sizes ---------------------------------------------------------------
const pyodideDir = join(here, "node_modules/pyodide");
const pyodideVersion = JSON.parse(readFileSync(join(pyodideDir, "package.json"), "utf8")).version;
const browserFiles = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const pySizes = [];
for (const f of browserFiles) {
  const p = join(pyodideDir, f);
  try {
    statSync(p);
  } catch {
    continue;
  }
  pySizes.push({ file: f, ...compressed(readFileSync(p)) });
}
const pyTotal = pySizes.reduce((a, s) => ({ raw: a.raw + s.raw, gzip: a.gzip + s.gzip, brotli: a.brotli + s.brotli }), {
  raw: 0,
  gzip: 0,
  brotli: 0,
});
console.log(`Pyodide ${pyodideVersion} runtime: ${fmtBytes(pyTotal.raw)} raw, ${fmtBytes(pyTotal.gzip)} gzip, ${fmtBytes(pyTotal.brotli)} brotli`);

// ---- Pyodide: correctness + speed on a worker thread --------------------------------------
const sources = Object.fromEntries(
  readdirSync(pySrcDir)
    .filter((f) => f.endsWith(".py"))
    .map((f) => [f, readFileSync(join(pySrcDir, f), "utf8")]),
);
const worker = new Worker(new URL("./pyodide-worker.mjs", import.meta.url), { workerData: { sources } });
const ready = await new Promise((resolve) => worker.once("message", resolve));
console.log(`Pyodide: load ${ready.load_ms.toFixed(0)} ms, import stackd_rules ${ready.import_ms.toFixed(0)} ms, RULES_VERSION ${ready.version}`);

let nextId = 1;
const pending = new Map();
worker.on("message", (m) => {
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
const callPy = (rule, input) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    worker.postMessage({ id, rule, input });
  });

let pyPass = 0;
const failures = [];
for (const c of cases) {
  const r = await callPy(c.rule, c.input);
  if (same(r.result, c.expected)) pyPass += 1;
  else failures.push(`${c.rule}/${c.name}: got ${JSON.stringify(r.result)}`);
}
const PY_ROUNDS = 20;
let pyUs = 0;
const pyRun0 = performance.now();
for (let i = 0; i < PY_ROUNDS; i++) for (const c of cases) pyUs += (await callPy(c.rule, c.input)).us;
const pyRoundTripUs = ((performance.now() - pyRun0) * 1000) / (PY_ROUNDS * cases.length);
const pyInsideUs = pyUs / (PY_ROUNDS * cases.length);
await worker.terminate();
console.log(`Pyodide: ${pyPass}/${cases.length} pass, ${pyInsideUs.toFixed(1)} us/call inside Python, ${pyRoundTripUs.toFixed(1)} us/call round trip`);

// ---- report --------------------------------------------------------------------------------
const machine = `${process.platform} ${process.arch}, Node ${process.version}`;
const lines = [
  "# Engine prototype measurements",
  "",
  `Generated by \`measure.mjs\` on ${new Date().toISOString().slice(0, 10)}, ${machine}. Golden cases: ${cases.length}.`,
  "",
  "**Not measured on a phone.** Timings below are from a desktop machine; they are a lower bound for a mid-range phone, not an estimate of it. Sizes are device-independent.",
  "",
  "## Download size (what the browser fetches before the first rule can run)",
  "",
  "| Candidate | Raw | gzip | brotli |",
  "|---|---|---|---|",
  `| TypeScript port (\`packages/rules\`, bundled + minified) | ${fmtBytes(tsSize.raw)} | ${fmtBytes(tsSize.gzip)} | ${fmtBytes(tsSize.brotli)} |`,
  `| Pyodide ${pyodideVersion} runtime (no app code yet) | ${fmtBytes(pyTotal.raw)} | ${fmtBytes(pyTotal.gzip)} | ${fmtBytes(pyTotal.brotli)} |`,
  "",
  "Pyodide files:",
  "",
  "| File | Raw | gzip | brotli |",
  "|---|---|---|---|",
  ...pySizes.map((s) => `| ${s.file} | ${fmtBytes(s.raw)} | ${fmtBytes(s.gzip)} | ${fmtBytes(s.brotli)} |`),
  "",
  "## Correctness",
  "",
  "| Candidate | Golden cases passing |",
  "|---|---|",
  `| TypeScript port | ${tsPass}/${cases.length} |`,
  `| Pyodide running the Python package | ${pyPass}/${cases.length} |`,
  ...(failures.length ? ["", "Pyodide failures:", "", ...failures.map((f) => `- ${f}`)] : []),
  "",
  "## Speed (desktop)",
  "",
  "| Candidate | Start-up before first call | Per rule call |",
  "|---|---|---|",
  `| TypeScript port | ${tsImportMs.toFixed(1)} ms (module import) | ${tsPerCallUs.toFixed(1)} µs (in-process) |`,
  `| Pyodide | ${ready.load_ms.toFixed(0)} ms (runtime) + ${ready.import_ms.toFixed(0)} ms (import stackd_rules) | ${pyInsideUs.toFixed(1)} µs inside Python, ${pyRoundTripUs.toFixed(1)} µs round trip via worker |`,
  "",
];
writeFileSync(join(here, "results.md"), lines.join("\n"));
console.log(`wrote ${join(here, "results.md")}`);
