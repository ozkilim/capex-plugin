// Outline tool: AST-accurate symbol map of a file or a glob of files, without
// reading bodies. Far cheaper than reading whole files when the agent only
// needs to know "what's defined here and where".
import fs from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";
import { outlineFile, langForFile } from "./ast.js";

export const outlineSchema = {
  type: "object",
  properties: {
    file: { type: "string", description: "Single file to outline (relative to cwd)." },
    file_glob_patterns: {
      type: "array",
      items: { type: "string" },
      description: "Glob patterns to outline many files at once. Use instead of `file`.",
    },
    cwd: { type: "string" },
    max_files: { type: "number", default: 100 },
    detail: {
      type: "string",
      enum: ["sig", "names"],
      default: "sig",
      description: "`sig` (default) lists each symbol's signature + line range. `names` lists just `name(kind)` per symbol — far less output; use when you only need the inventory of symbols (e.g. an API listing).",
    },
  },
};

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"];

export async function doOutline(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const maxFiles = args.max_files ?? 100;
  const detail = args.detail === "names" ? "names" : "sig";

  let rels = [];
  if (args.file) {
    rels = [args.file];
  } else if (args.file_glob_patterns && args.file_glob_patterns.length) {
    rels = (await glob(args.file_glob_patterns, { cwd, ignore: DEFAULT_IGNORE, onlyFiles: true, absolute: false })).sort();
  }
  if (!rels.length) {
    return { text: "(no files matched)", meta: { mode: "outline", files: 0, symbols: 0, linesElided: 0 } };
  }

  let capped = false;
  if (rels.length > maxFiles) { rels = rels.slice(0, maxFiles); capped = true; }

  const blocks = [];
  let totalSymbols = 0;
  let linesElided = 0;
  let unsupported = 0;

  for (const rel of rels) {
    const abs = path.join(cwd, rel);
    if (!langForFile(abs)) { unsupported++; continue; }
    let syms;
    try { syms = await outlineFile(abs); } catch { syms = []; }
    if (syms == null) { unsupported++; continue; }
    // Count the file's lines as "elided" (the agent learned its structure
    // without reading them) — used for the savings estimate.
    try { linesElided += fs.readFileSync(abs, "utf8").split("\n").length; } catch {}
    totalSymbols += syms.length;
    if (detail === "names") {
      // Compact inventory: one short token per symbol, all on one line.
      const names = syms.length ? syms.map((s) => `${s.name}(${s.kind})`).join(", ") : "(none)";
      blocks.push(`${rel}: ${names}`);
      continue;
    }
    const lines = [rel];
    if (!syms.length) lines.push("  (no top-level symbols)");
    for (const s of syms) {
      const range = s.endLine > s.line ? `L${s.line}-${s.endLine}` : `L${s.line}`;
      // sig already carries the language keyword (function/class/def/...); fall
      // back to `kind name` only when there's no signature line.
      lines.push(`  ${s.sig || `${s.kind} ${s.name}`}  ${range}`);
    }
    blocks.push(lines.join("\n"));
  }

  let text = blocks.length ? blocks.join("\n\n") : "(no supported source files)";
  if (capped) text += `\n\n… capped at ${maxFiles} files`;
  if (unsupported) text += `\n(${unsupported} file(s) skipped: unsupported language)`;

  return {
    text,
    meta: { mode: "outline", files: blocks.length, symbols: totalSymbols, linesElided },
  };
}
