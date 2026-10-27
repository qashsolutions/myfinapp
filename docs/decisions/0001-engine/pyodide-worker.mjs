// Loads Pyodide on a worker thread, installs stackd_rules from source, answers {id, rule, input}.
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

import { loadPyodide } from "pyodide";

const t0 = performance.now();
const py = await loadPyodide();
const loadMs = performance.now() - t0;

py.FS.mkdirTree("/rules/stackd_rules");
for (const [name, src] of Object.entries(workerData.sources)) {
  py.FS.writeFile(`/rules/stackd_rules/${name}`, src);
}
const t1 = performance.now();
py.runPython(`
import json, sys
sys.path.insert(0, "/rules")
from stackd_rules.registry import RULES
from stackd_rules.errors import RuleError
from stackd_rules import RULES_VERSION

def run(rule, payload):
    try:
        return json.dumps(RULES[rule](**json.loads(payload)))
    except RuleError as e:
        return json.dumps({"error": e.code})
`);
const run = py.globals.get("run");
const version = py.globals.get("RULES_VERSION");
const importMs = performance.now() - t1;

parentPort.postMessage({ type: "ready", load_ms: loadMs, import_ms: importMs, version, pyodide: py.version });
parentPort.on("message", (msg) => {
  const t = performance.now();
  const out = run(msg.rule, JSON.stringify(msg.input));
  const us = (performance.now() - t) * 1000;
  parentPort.postMessage({ id: msg.id, result: JSON.parse(out), us });
});
