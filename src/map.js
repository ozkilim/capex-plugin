// Map: a one-call repo skeleton for COLD-START orientation. Every coding task
// begins by figuring out "what's in this repo and where". Vanilla does that with
// a chain of ls/glob/Grep + reading several files — many turns, and the file
// bodies enter context (fresh tokens) and are then re-billed as cache-read on
// every later turn. Map returns the whole structure in one terse call: each
// source file with the NAMES of the symbols it defines, plus other files listed.
// No bodies, no signatures — just the inventory you need to navigate.
import path from "node:path";
import { glob } from "tinyglobby";
import { outlineFile, langForFile } from "./ast.js";

export const mapSchema = {
  type: "object",
  properties: {
    file_glob_patterns: {
      type: "array",
      items: { type: "string" },
      description: "What to map. Default: everything under cwd (excluding deps/build).",
    },
    cwd: { type: "string" },
    max_files: { type: "number", default: 300 },
  },
};

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/*.lock", "**/*.min.*"];

export async function doMap(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const maxFiles = args.max_files ?? 300;
  const patterns = args.file_glob_patterns && args.file_glob_patterns.length ? args.file_glob_patterns : ["**/*"];

  let rels = (await glob(patterns, { cwd, ignore: DEFAULT_IGNORE, onlyFiles: true, absolute: false })).sort();
  let capped = false;
  if (rels.length > maxFiles) { rels = rels.slice(0, maxFiles); capped = true; }

  const lines = [];
  let sourceFiles = 0;
  let totalSymbols = 0;
  for (const rel of rels) {
    const abs = path.join(cwd, rel);
    if (!langForFile(abs)) { lines.push(rel); continue; }
    let syms;
    try { syms = await outlineFile(abs); } catch { syms = null; }
    if (syms == null) { lines.push(rel); continue; }
    sourceFiles++;
    totalSymbols += syms.length;
    const names = syms.length ? syms.map((s) => s.name).join(", ") : "(no exports)";
    lines.push(`${rel}  ::  ${names}`);
  }

  let text = lines.length ? lines.join("\n") : "(no files matched)";
  if (capped) text += `\n… capped at ${maxFiles} files`;
  return {
    text,
    meta: { mode: "map", files: rels.length, sourceFiles, symbols: totalSymbols },
  };
}
