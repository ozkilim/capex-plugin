// Where: fuse Def + Refs into ONE call. "Tell me everything about symbol X" is
// the most common navigation question, and answering it separately costs two
// roundtrips. Where returns the definition (signature + line range) AND all call
// sites across the repo, AST-precise, in one terse result.
import path from "node:path";
import { glob } from "tinyglobby";
import { findReferences, findDefinitions, langForFile } from "./ast.js";

export const whereSchema = {
  type: "object",
  required: ["symbol"],
  properties: {
    symbol: { type: "string", description: "Symbol name to locate + trace." },
    file_glob_patterns: { type: "array", items: { type: "string" }, description: "Globs to scan. Default: all supported source files under cwd." },
    cwd: { type: "string" },
    max_results: { type: "number", default: 200 },
  },
};

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"];

export async function doWhere(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const symbol = args.symbol;
  if (!symbol) return { text: "(no symbol given)", meta: { mode: "where", defs: 0, refs: 0, files: 0 } };
  const max = args.max_results ?? 200;

  const patterns = args.file_glob_patterns && args.file_glob_patterns.length ? args.file_glob_patterns : ["**/*"];
  const rels = (await glob(patterns, { cwd, ignore: DEFAULT_IGNORE, onlyFiles: true, absolute: false }))
    .filter((f) => langForFile(f)).sort();

  const defs = [];
  const refBlocks = [];
  let refCount = 0;
  const filesWithRefs = new Set();

  for (const rel of rels) {
    const abs = path.join(cwd, rel);
    try {
      const ds = await findDefinitions(abs, symbol);
      for (const d of ds || []) {
        const range = d.endLine > d.line ? `L${d.line}-${d.endLine}` : `L${d.line}`;
        defs.push(`  ${rel}  ${d.sig || `${d.kind} ${d.name}`}  ${range}`);
      }
    } catch {}
    if (refCount < max) {
      let hits;
      try { hits = await findReferences(abs, symbol); } catch { hits = null; }
      if (hits && hits.length) {
        filesWithRefs.add(rel);
        const ls = [rel];
        for (const h of hits) {
          if (refCount >= max) break;
          ls.push(`  ${h.line}:${h.col}  ${h.text}`);
          refCount++;
        }
        refBlocks.push(ls.join("\n"));
      }
    }
  }

  const parts = [];
  parts.push(defs.length ? `DEFINITION(S) of \`${symbol}\`:\n${defs.join("\n")}` : `No definition of \`${symbol}\` found.`);
  parts.push(refBlocks.length ? `\n${refCount} REFERENCE(S) across ${filesWithRefs.size} file(s):\n${refBlocks.join("\n\n")}` : `\nNo references found.`);
  return {
    text: parts.join("\n"),
    meta: { mode: "where", defs: defs.length, refs: refCount, files: filesWithRefs.size },
  };
}
