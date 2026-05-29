// Insert: add code at an AST-anchored position WITHOUT quoting the surrounding
// code. To add a function/import, Edit needs an old_string anchor (echoed as
// output, and a failure risk if it doesn't match). Insert says "put this after
// symbol foo" / "before bar" / "at end" / "at top" and the tool finds the line.
// Cheaper output (no anchor echo) and no failed-match retries for additions.
import fs from "node:fs";
import path from "node:path";
import { outlineFile, langForFile } from "./ast.js";

export const insertSchema = {
  type: "object",
  required: ["file", "content"],
  properties: {
    file: { type: "string" },
    content: { type: "string", description: "Text to insert (verbatim)." },
    after_symbol: { type: "string", description: "Insert right after this function/class definition." },
    before_symbol: { type: "string", description: "Insert right before this function/class definition." },
    position: { type: "string", enum: ["end", "top"], description: "Insert at end of file or top (after a leading comment/import block). Used when no symbol anchor is given." },
    cwd: { type: "string" },
  },
};

export async function doInsert(args = {}) {
  const abs = path.resolve(args.cwd || process.cwd(), args.file);
  let content;
  try { content = fs.readFileSync(abs, "utf8"); } catch (e) {
    return { text: `Error reading ${args.file}: ${e.code || e.message}`, meta: { mode: "insert", inserted: false } };
  }
  const lines = content.split("\n");
  const insertText = args.content;

  let at = null; // 0-indexed line BEFORE which to splice
  let how = "";

  if (args.after_symbol || args.before_symbol) {
    const sym = args.after_symbol || args.before_symbol;
    if (!langForFile(abs)) return { text: `Symbol anchoring needs a supported language; ${args.file} isn't one. Use position:"end".`, meta: { mode: "insert", inserted: false } };
    let syms;
    try { syms = await outlineFile(abs); } catch { syms = null; }
    const def = (syms || []).find((s) => s.name === sym);
    if (!def) {
      const names = [...new Set((syms || []).map((s) => s.name))].slice(0, 40).join(", ");
      return { text: `No symbol \`${sym}\` in ${args.file}.${names ? ` Symbols: ${names}.` : ""}`, meta: { mode: "insert", inserted: false } };
    }
    if (args.after_symbol) { at = def.endLine; how = `after ${sym}`; }
    else { at = def.line - 1; how = `before ${sym}`; }
  } else if (args.position === "top") {
    // After a leading block of comments / imports.
    let i = 0;
    while (i < lines.length && /^\s*(\/\/|\/\*|\*|#|import\b|export\b.*from|const\s+\w+\s*=\s*require|\s*$)/.test(lines[i])) i++;
    at = i; how = "at top";
  } else {
    at = lines.length; how = "at end";
  }

  const block = insertText.split("\n");
  // Cosmetic: ensure a blank line separates inserted block from neighbours.
  const needsLeadGap = at > 0 && lines[at - 1] && lines[at - 1].trim() !== "";
  const newLines = [...lines.slice(0, at)];
  if (needsLeadGap) newLines.push("");
  newLines.push(...block);
  if (at < lines.length && lines[at] && lines[at].trim() !== "") newLines.push("");
  newLines.push(...lines.slice(at));

  const updated = newLines.join("\n");
  const tmp = abs + ".capex-tmp";
  try {
    fs.writeFileSync(tmp, updated, "utf8");
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    return { text: `Error writing ${args.file}: ${e.message}`, meta: { mode: "insert", inserted: false } };
  }

  // Optional parse check feedback (multi-language, no subprocess).
  let verify = "";
  try {
    const { hasParseErrors } = await import("./ast.js");
    const bad = await hasParseErrors(abs);
    if (bad === true) verify = " ⚠ file now has a syntax error";
    else if (bad === false) verify = " ✓ parses";
  } catch {}

  return {
    text: `Inserted ${block.length} line(s) ${how} in ${args.file}.${verify}`,
    meta: { mode: "insert", inserted: true, lines: block.length },
  };
}
