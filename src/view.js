// View: read exactly ONE symbol (function/class/method) by name, using the AST
// to find its line range — instead of reading the whole file (fresh-context
// waste) or guessing offset/limit (a wasted-turn risk when the guess is wrong).
// Returns the symbol's body with line-number gutters, nothing else.
import fs from "node:fs";
import path from "node:path";
import { findDefinitions, langForFile, outlineFile } from "./ast.js";

export const viewSchema = {
  type: "object",
  required: ["file", "symbol"],
  properties: {
    file: { type: "string", description: "File to read from (relative to cwd)." },
    symbol: { type: "string", description: "Name of the function/class/method to view." },
    cwd: { type: "string" },
  },
};

export async function doView(args = {}) {
  const file = args.file;
  const symbol = args.symbol;
  const abs = path.resolve(args.cwd || process.cwd(), file);

  if (!langForFile(abs)) {
    return { text: `View needs a supported source language; ${file} is unsupported. Use Read with offset/limit.`, meta: { mode: "view", found: 0, linesReturned: 0 } };
  }

  let content;
  try { content = fs.readFileSync(abs, "utf8"); } catch (err) {
    return { text: `Error reading ${file}: ${err.code || err.message}`, meta: { mode: "view", found: 0, linesReturned: 0 } };
  }
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  let defs;
  try { defs = await findDefinitions(abs, symbol); } catch { defs = null; }

  if (!defs || !defs.length) {
    // Give the agent the symbol list so it can recover in one turn rather than
    // re-reading the whole file to find the right name.
    let names = [];
    try { names = (await outlineFile(abs) || []).map((s) => s.name); } catch {}
    const hint = names.length ? ` Symbols here: ${[...new Set(names)].slice(0, 40).join(", ")}.` : "";
    return { text: `No definition of \`${symbol}\` found in ${file}.${hint}`, meta: { mode: "view", found: 0, linesReturned: 0, totalLines } };
  }

  const blocks = [];
  let linesReturned = 0;
  for (const d of defs) {
    const start = Math.max(1, d.line);
    const end = Math.min(totalLines, d.endLine || d.line);
    const slice = allLines.slice(start - 1, end);
    linesReturned += slice.length;
    const body = slice.map((l, k) => `${start + k}: ${l}`).join("\n");
    blocks.push(`${file}:${start}-${end}\n${body}`);
  }

  return {
    text: blocks.join("\n\n"),
    meta: { mode: "view", found: defs.length, linesReturned, totalLines },
  };
}
