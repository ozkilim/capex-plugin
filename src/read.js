import fs from "node:fs";
import path from "node:path";

export const readSchema = {
  type: "object",
  properties: {
    file: { type: "string" },
    files: { type: "array", items: { type: "string" }, description: "Read several files in ONE call (saves roundtrips). Each is returned with a header. offset/limit/signatures_only apply to all." },
    offset: { type: "number", description: "1-indexed start line. Default 1." },
    limit: { type: "number", description: "Max lines to return. Default 2000." },
    signatures_only: {
      type: "boolean",
      default: false,
      description: "Keep top-level function/class signatures, elide bodies."
    },
    code_only: {
      type: "boolean",
      default: false,
      description: "Drop comment-only and blank lines (keeps line numbers). Cuts tokens on doc-heavy files when you only care about the code."
    }
  }
};

const DEFAULT_LIMIT = 2000;
// Above this many lines, a Read with no explicit range returns structure + a
// head instead of dumping the whole file (a fresh-context guardrail).
const BIG_FILE_LINES = 800;

// Comment-only / blank line across common languages (best-effort, line-based).
function isNoise(line) {
  const t = line.trim();
  if (t === "") return true;
  return /^(\/\/|\/\*|\*\/|\*|#|--)/.test(t);
}

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
  // Multi-file mode: read each file in one roundtrip, concatenated with headers.
  if (Array.isArray(args.files) && args.files.length) {
    const parts = [];
    let totalLines = 0;
    for (const f of args.files) {
      const one = await doRead({ ...args, files: undefined, file: f });
      totalLines += one.meta.totalLines || 0;
      parts.push(`===== ${f} =====\n${one.text}`);
    }
    return {
      text: parts.join("\n\n"),
      meta: { lines: 0, totalLines, truncated: false, signaturesOnly: !!args.signatures_only, mode: "read", files: args.files.length },
    };
  }
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

  // Large-file guardrail: no explicit range on a huge file would dump it all
  // (and re-bill it every later turn). Return signatures + a head instead, and
  // tell the model how to get more.
  if (!args.code_only && totalLines > BIG_FILE_LINES && args.offset == null && args.limit == null) {
    const rows = signaturesOnly(allLines);
    const text =
      `${args.file} is ${totalLines} lines — showing structure only. ` +
      `Use offset/limit for a range, or View <symbol> for one definition.\n` +
      rows.map((r) => (r.elide ? r.text : `${r.n}: ${r.text}`)).join("\n");
    return { text, meta: { lines: rows.length, totalLines, truncated: true, signaturesOnly: true, mode: "signatures_only" } };
  }

  const offset = Math.max(1, args.offset ?? 1);
  const limit = args.limit ?? DEFAULT_LIMIT;
  const startIdx = offset - 1;
  const endIdx = Math.min(allLines.length, startIdx + limit);
  let slice = allLines.slice(startIdx, endIdx);
  const truncated = endIdx < allLines.length || startIdx > 0;

  let rendered;
  if (args.code_only) {
    rendered = slice
      .map((l, k) => ({ n: startIdx + k + 1, l }))
      .filter((r) => !isNoise(r.l))
      .map((r) => `${r.n}: ${r.l}`)
      .join("\n");
  } else {
    rendered = slice.map((l, k) => `${startIdx + k + 1}: ${l}`).join("\n");
  }
  return {
    text: rendered,
    meta: { lines: slice.length, totalLines, truncated, signaturesOnly: false, codeOnly: !!args.code_only, mode: "read" }
  };
}
