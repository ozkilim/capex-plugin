// Imports: "which files import module X?" (and optionally "what does file Y
// import?") in one terse call. Tracing how a module is wired is a classic
// grep→read→grep loop; this returns just file:line of each import edge, so the
// agent learns the dependency structure without reading whole files.
import fs from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";

export const importsSchema = {
  type: "object",
  properties: {
    module: { type: "string", description: "Module name or path fragment to find importers of (e.g. 'logger', './util/money.js')." },
    of_file: { type: "string", description: "Instead, list what THIS file imports." },
    file_glob_patterns: { type: "array", items: { type: "string" }, description: "Files to scan. Default: all source files under cwd." },
    cwd: { type: "string" },
    max_results: { type: "number", default: 200 },
  },
};

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"];
const SRC_GLOB = ["**/*.{js,jsx,mjs,cjs,ts,tsx,py,go,rs,java,rb}"];

// Lines that introduce a dependency, across common languages.
const IMPORT_LINE = /^\s*(import\b|export\b.*\bfrom\b|from\s+\S+\s+import\b|.*\brequire\s*\(|#include\b|use\s+\w)/;

function moduleKey(spec) {
  // Normalize './util/money.js' or 'logger' to a comparable basename-ish token.
  const base = spec.replace(/['"`;]/g, "").trim();
  return base;
}

export async function doImports(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const max = args.max_results ?? 200;
  const patterns = args.file_glob_patterns && args.file_glob_patterns.length ? args.file_glob_patterns : SRC_GLOB;
  const files = (await glob(patterns, { cwd, ignore: DEFAULT_IGNORE, onlyFiles: true, absolute: false })).sort();

  // Mode B: what does of_file import?
  if (args.of_file) {
    let src;
    try { src = fs.readFileSync(path.join(cwd, args.of_file), "utf8"); } catch (e) {
      return { text: `Error reading ${args.of_file}: ${e.code || e.message}`, meta: { mode: "imports", files: 0, edges: 0 } };
    }
    const out = [];
    src.split("\n").forEach((l, i) => { if (IMPORT_LINE.test(l)) out.push(`${i + 1}: ${l.trim().slice(0, 160)}`); });
    return {
      text: out.length ? `${args.of_file} imports:\n${out.join("\n")}` : `${args.of_file} has no imports.`,
      meta: { mode: "imports", files: 1, edges: out.length },
    };
  }

  // Mode A: who imports `module`?
  const needle = args.module ? moduleKey(args.module) : null;
  if (!needle) return { text: "Provide `module` (find importers) or `of_file` (list its imports).", meta: { mode: "imports", files: 0, edges: 0 } };
  const baseName = needle.replace(/\.[a-z]+$/i, "").split("/").pop();

  const hits = [];
  let edges = 0;
  const filesHit = new Set();
  for (const rel of files) {
    if (edges >= max) break;
    let buf;
    try { buf = fs.readFileSync(path.join(cwd, rel), "utf8"); } catch { continue; }
    const lines = buf.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (edges >= max) break;
      const l = lines[i];
      if (!IMPORT_LINE.test(l)) continue;
      if (l.includes(needle) || (baseName && new RegExp(`['"\`/]${baseName}(\\.[a-z]+)?['"\`]`).test(l))) {
        hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 140)}`);
        filesHit.add(rel);
        edges++;
      }
    }
  }
  return {
    text: hits.length ? hits.join("\n") : `(no files import \`${args.module}\`)`,
    meta: { mode: "imports", files: filesHit.size, edges },
  };
}
