/**
 * Writes src/data/licenses.json for the Open-source licenses page: the JavaScript packages the
 * app and the site ship (pnpm's listing) and the Python packages the API runs on (their
 * installed metadata). Run from the repo root: `pnpm -C apps/site licenses`.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Row {
  name: string;
  license: string;
  homepage?: string;
}

const root = resolve(import.meta.dirname, "../../..");

const js: Row[] = [];
const listing = JSON.parse(
  execFileSync(
    "pnpm",
    ["licenses", "list", "--json", "--prod", "--filter", "@stackd/web", "--filter", "@stackd/site"],
    { cwd: root, encoding: "utf8" },
  ),
) as Record<string, Array<{ name: string; license: string; homepage?: string }>>;
for (const [license, packages] of Object.entries(listing))
  for (const p of packages)
    if (!p.name.startsWith("@stackd/")) js.push({ name: p.name, license, homepage: p.homepage });
js.sort((a, b) => a.name.localeCompare(b.name));

const python = JSON.parse(
  execFileSync(
    "uv",
    [
      "run",
      "--project",
      "services/api",
      "python",
      "-c",
      [
        "import json, importlib.metadata as m",
        "rows = []",
        "for d in m.distributions():",
        "    name = d.metadata['Name']",
        "    lic = d.metadata.get('License-Expression') or ''",
        "    if not lic:",
        "        cls = [c for c in d.metadata.get_all('Classifier') or [] if c.startswith('License ::')]",
        "        lic = cls[0].split('::')[-1].strip() if cls else (d.metadata.get('License') or '').splitlines()[0][:60] if d.metadata.get('License') else 'see project'",
        "    home = d.metadata.get('Home-page') or next((u.split(',',1)[1].strip() for u in d.metadata.get_all('Project-URL') or [] if u.lower().startswith(('homepage', 'source', 'repository'))), None)",
        "    if not name.startswith('stackd'): rows.append({'name': name, 'license': lic, 'homepage': home})",
        "print(json.dumps(sorted(rows, key=lambda r: r['name'].lower())))",
      ].join("\n"),
    ],
    { cwd: root, encoding: "utf8" },
  ),
) as Row[];

const out = resolve(import.meta.dirname, "../src/data/licenses.json");
writeFileSync(out, `${JSON.stringify({ javascript: js, python }, null, 2)}\n`);
console.log(`wrote ${out}: ${js.length} JavaScript, ${python.length} Python`);
