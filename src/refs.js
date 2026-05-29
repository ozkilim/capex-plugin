// Refs / Def tools: AST-precise "find all call sites of X" and "where is X
// defined", across a file or glob. Replaces grep-then-read-each-hit loops, and
// avoids regex false positives (comments, substrings) that cause wasted reads.
import path from "node:path";
import { glob } from "tinyglobby";
import { findReferences, findDefinitions, langForFile } from "./ast.js";

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"];

const common = {
  symbol: { type: "string", description: "Symbol name to look up (function/class/variable identifier)." },
  file: { type: "string", description: "Limit to a single file (relative to cwd)." },
  file_glob_patterns: { type: "array", items: { type: "string" }, description: "Globs to scan. Defaults to all supported source files under cwd." },
  cwd: { type: "string" },
  max_results: { type: "number", default: 200 },
};

export const refsSchema = { type: "object", required: ["symbol"], properties: { ...common } };
export const defSchema = { type: "object", required: ["symbol"], properties: { ...common } };

async function gatherFiles(args, cwd) {
  if (args.file) return [args.file];
  const patterns = args.file_glob_patterns && args.file_glob_patterns.length ? args.file_glob_patterns : ["**/*"];
  const all = await glob(patterns, { cwd, ignore: DEFAULT_IGNORE, onlyFiles: true, absolute: false });
  return all.filter((f) => langForFile(f)).sort();
}

export async function doRefs(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const symbol = args.symbol;
  if (!symbol) return { text: "(no symbol given)", meta: { mode: "refs", files: 0, refs: 0 } };
  const max = args.max_results ?? 200;
  const rels = await gatherFiles(args, cwd);

  const blocks = [];
  let totalRefs = 0;
  let capped = false;
  for (const rel of rels) {
    if (totalRefs >= max) { capped = true; break; }
    let hits;
    try { hits = await findReferences(path.join(cwd, rel), symbol); } catch { hits = null; }
    if (!hits || !hits.length) continue;
    const lines = [rel];
    for (const h of hits) {
      if (totalRefs >= max) { capped = true; break; }
      lines.push(`  ${h.line}:${h.col}  ${h.text}`);
      totalRefs++;
    }
    blocks.push(lines.join("\n"));
  }

  let text = blocks.length ? blocks.join("\n\n") : `(no references to \`${symbol}\` found)`;
  if (capped) text += `\n\n… capped at ${max} references`;
  return { text, meta: { mode: "refs", files: blocks.length, refs: totalRefs } };
}

export async function doDef(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const symbol = args.symbol;
  if (!symbol) return { text: "(no symbol given)", meta: { mode: "def", files: 0, defs: 0 } };
  const rels = await gatherFiles(args, cwd);

  const blocks = [];
  let totalDefs = 0;
  for (const rel of rels) {
    let defs;
    try { defs = await findDefinitions(path.join(cwd, rel), symbol); } catch { defs = null; }
    if (!defs || !defs.length) continue;
    const lines = [rel];
    for (const d of defs) {
      const range = d.endLine > d.line ? `L${d.line}-${d.endLine}` : `L${d.line}`;
      lines.push(`  ${d.sig || `${d.kind} ${d.name}`}  ${range}`);
      totalDefs++;
    }
    blocks.push(lines.join("\n"));
  }

  const text = blocks.length ? blocks.join("\n\n") : `(no definition of \`${symbol}\` found)`;
  return { text, meta: { mode: "def", files: blocks.length, defs: totalDefs } };
}
