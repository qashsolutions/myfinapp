/**
 * One design system on every screen (owner, October 28, 2026). Seven text sizes: Every font size in the app's and the
 * UI kit's stylesheets and inline styles is one of the --fs-* tokens in packages/ui/src/ui.css
 * (or relative: em, %, inherit); a raw px or rem size fails here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join(__dirname, "../../src"), join(__dirname, "../../../../packages/ui/src")];
const RAW = /font(?:-size)?\s*:[^;]*?\b[0-9.]+(?:px|rem)\b/;
const INLINE = /fontSize:\s*["'][0-9.]+(?:px|rem)["']/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(css|tsx?)$/.test(name) ? [path] : [];
  });
}

it("every font size is a type-scale token", () => {
  const offenders: string[] = [];
  for (const root of ROOTS)
    for (const file of files(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes("--fs-")) return; // the scale itself, and lines that use it
        if ((file.endsWith(".css") && RAW.test(line)) || INLINE.test(line))
          offenders.push(`${file.split("/src/")[1]}:${i + 1}: ${line.trim()}`);
      });
    }
  expect(offenders).toEqual([]);
});

it("every colour is a token the palette defines", () => {
  const css = readFileSync(join(__dirname, "../../../../packages/tokens/dist/tokens.css"), "utf8");
  const defined = new Set(css.match(/--c-[a-z0-9-]+/g));
  const missing: string[] = [];
  for (const root of ROOTS)
    for (const file of files(root))
      for (const m of readFileSync(file, "utf8").matchAll(/var\((--c-[a-z0-9-]+)/g))
        if (!defined.has(m[1] as string)) missing.push(`${file.split("/src/")[1]}: ${m[1]}`);
  expect(missing).toEqual([]);
});
