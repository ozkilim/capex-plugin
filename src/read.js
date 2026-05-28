import fs from "node:fs";
import path from "node:path";

export const readSchema = {
  type: "object",
  required: ["file"],
  properties: {
    file: { type: "string" },
    offset: { type: "number", description: "1-indexed start line. Default 1." },
    limit: { type: "number", description: "Max lines to return. Default 2000." },
    signatures_only: {
      type: "boolean",
      default: false,
      description: "Keep top-level function/class signatures, elide bodies."
    }
  }
};

const DEFAULT_LIMIT = 2000;

// Judgment call: signatures_only is a regex heuristic, not an AST parser.
// We keep any line that looks like a top-level declaration/signature across
// JS/TS, Python, Go, Rust, and elide everything else, marking gaps with "…".
const SIGNATURE_RE = new RegExp(
  [
    "^\\s*(export\\s+)?(default\\s+)?(async\\s+)?function\\b",
    "^\\s*(export\\s+)?(abstract\\s+)?class\\b",
    "^\\s*(export\\s+)?(interface|type|enum)\\b",
    "^\\s*(export\\s+)?(const|let|var)\\s+[A-Za-z0-9_$]+\\s*=\\s*(async\\s*)?\\(",
    "^\\s*def\\b",
    "^\\s*func\\b",
    "^\\s*(pub\\s+)?(async\\s+)?fn\\b",
    "^\\s*(export\\s+)?(public|private|protected|static)\\b.*\\(",
    "^\\s*[A-Za-z0-9_$]+\\s*\\([^)]*\\)\\s*\\{\\s*$"
  ].join("|")
);

function signaturesOnly(lines) {
  const out = [];
  let elided = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SIGNATURE_RE.test(line)) {
      out.push({ n: i + 1, text: line });
      elided = false;
    } else if (/^\s*[}\])]/.test(line) && line.trim().length <= 3) {
      // keep short closing brackets so structure reads cleanly
      out.push({ n: i + 1, text: line });
      elided = false;
    } else if (!elided) {
      out.push({ n: i + 1, text: "  …", elide: true });
      elided = true;
    }
  }
  return out;
}

export async function doRead(args = {}) {
  const abs = path.resolve(args.file);
  let content;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch (err) {
    return { text: `Error reading ${args.file}: ${err.code || err.message}`, meta: { lines: 0, totalLines: 0, truncated: false, mode: "read" } };
  }

  const allLines = content.split("\n");
  const totalLines = allLines.length;

  if (args.signatures_only) {
    const rows = signaturesOnly(allLines);
    const text = rows
      .map((r) => (r.elide ? r.text : `${r.n}: ${r.text}`))
      .join("\n");
    return {
      text,
      meta: { lines: rows.length, totalLines, truncated: false, signaturesOnly: true, mode: "signatures_only" }
    };
  }

  const offset = Math.max(1, args.offset ?? 1);
  const limit = args.limit ?? DEFAULT_LIMIT;
  const startIdx = offset - 1;
  const endIdx = Math.min(allLines.length, startIdx + limit);
  const slice = allLines.slice(startIdx, endIdx);
  const truncated = endIdx < allLines.length || startIdx > 0;

  const text = slice.map((l, k) => `${startIdx + k + 1}: ${l}`).join("\n");
  return {
    text,
    meta: { lines: slice.length, totalLines, truncated, signaturesOnly: false, mode: "read" }
  };
}
