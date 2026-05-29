import fs from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";

export const searchSchema = {
  type: "object",
  properties: {
    file_glob_patterns: {
      type: "array",
      items: { type: "string" },
      description: "Glob patterns relative to cwd. Multiple allowed."
    },
    content_regex: {
      type: "string",
      description: "Optional regex matched per-line. Multiline allowed via (?s)."
    },
    max_results: { type: "number", default: 50 },
    context_lines: { type: "number", default: 0, description: "Lines of context around each hit. Default 0 = terse `file:line: text` (cheapest). Set >0 only when you need surrounding code." },
    cwd: { type: "string" }
  }
};

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"];
const MAX_LINE = 500;

function truncateLine(s) {
  if (s.length <= MAX_LINE) return s;
  return s.slice(0, MAX_LINE) + "… [truncated]";
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function doSearch(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const patterns = args.file_glob_patterns && args.file_glob_patterns.length
    ? args.file_glob_patterns
    : ["**/*"];
  const maxResults = args.max_results ?? 50;
  const contextLines = args.context_lines ?? 0;

  const files = await glob(patterns, {
    cwd,
    ignore: DEFAULT_IGNORE,
    dot: false,
    onlyFiles: true,
    absolute: false
  });
  files.sort();

  // No content regex: return deduped file list.
  if (!args.content_regex) {
    const text = files.length
      ? files.join("\n")
      : "(no files matched)";
    return { text, meta: { filesScanned: files.length, matches: files.length, capped: false, mode: "search" } };
  }

  const flags = "g";
  let re;
  try {
    re = new RegExp(args.content_regex, args.content_regex.startsWith("(?s)") ? "gs" : flags);
  } catch (e) {
    return { text: `Invalid content_regex: ${e.message}`, meta: { filesScanned: 0, matches: 0, capped: false, mode: "search" } };
  }

  const blocks = [];
  let matches = 0;
  let filesScanned = 0;
  let capped = false;

  for (const rel of files) {
    if (matches >= maxResults) { capped = true; break; }
    const abs = path.join(cwd, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    filesScanned++;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      matches++;
      // Terse default (context_lines=0): one line per hit, `file:line: text`.
      if (contextLines <= 0) {
        blocks.push(`${rel}:${i + 1}: ${truncateLine(lines[i].trim())}`);
        if (matches >= maxResults) { capped = true; break; }
        continue;
      }
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      const out = [`${rel}:${i + 1}`];
      for (let j = start; j <= end; j++) {
        const prefix = j === i ? "> " : "| ";
        out.push(prefix + truncateLine(lines[j]));
      }
      out.push("---");
      blocks.push(out.join("\n"));
      if (matches >= maxResults) { capped = true; break; }
    }
  }

  const text = blocks.length ? blocks.join("\n") : "(no matches)";
  return { text, meta: { filesScanned, matches, capped, mode: "search" } };
}
