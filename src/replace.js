// Replace: server-side multi-file find/replace that returns a ONE-LINE summary
// instead of echoing the edits. This is the highest-leverage cost lever we have:
// a multi-file rename via batched Edit re-emits every {old,new} pair as
// 5×-priced OUTPUT tokens; doing the mutation in the tool and returning
// "replaced N occurrences in M files" turns a multi-thousand-token output into
// ~15 tokens. Safer than `sed` (word-boundary + structural literal matching),
// and far cheaper than Edit at scale.
import fs from "node:fs";
import path from "node:path";
import { glob } from "tinyglobby";

export const replaceSchema = {
  type: "object",
  properties: {
    old_string: { type: "string", description: "Text to find (literal by default)." },
    new_string: { type: "string", description: "Replacement. With is_regex, $1.. backreferences work." },
    replacements: {
      type: "array",
      description: "Apply SEVERAL find/replace pairs across the same files in ONE call (e.g. rename multiple symbols at once). Each item: {old_string, new_string, is_regex?, word_boundary?}.",
      items: {
        type: "object",
        required: ["old_string", "new_string"],
        properties: {
          old_string: { type: "string" },
          new_string: { type: "string" },
          is_regex: { type: "boolean" },
          word_boundary: { type: "boolean" },
        },
      },
    },
    file_glob_patterns: {
      type: "array",
      items: { type: "string" },
      description: "Files to edit (globs, relative to cwd). Default: all text files.",
    },
    is_regex: { type: "boolean", default: false, description: "Treat old_string as a JS regex." },
    word_boundary: {
      type: "boolean",
      default: false,
      description: "Match old_string only as a whole word/identifier — the safe choice for renaming a function/variable everywhere.",
    },
    cwd: { type: "string" },
  },
};

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**"];

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(spec) {
  let pattern = spec.is_regex ? spec.old_string : escapeRe(spec.old_string);
  if (spec.word_boundary) pattern = `\\b${pattern}\\b`;
  return { re: new RegExp(pattern, "g"), repl: spec.new_string ?? "" };
}

export async function doReplace(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const patterns = args.file_glob_patterns && args.file_glob_patterns.length ? args.file_glob_patterns : ["**/*"];

  // Build the list of find/replace specs (single or multi).
  const specs = Array.isArray(args.replacements) && args.replacements.length
    ? args.replacements
    : [{ old_string: args.old_string, new_string: args.new_string, is_regex: args.is_regex, word_boundary: args.word_boundary }];
  for (const s of specs) {
    if (s.old_string == null || s.old_string === "") {
      return { text: "each replacement needs a non-empty old_string", meta: { mode: "replace", files: 0, occurrences: 0 } };
    }
  }
  let compiled;
  try {
    compiled = specs.map(compile);
  } catch (e) {
    return { text: `Invalid pattern: ${e.message}`, meta: { mode: "replace", files: 0, occurrences: 0 } };
  }

  const files = (await glob(patterns, { cwd, ignore: DEFAULT_IGNORE, onlyFiles: true, absolute: false })).sort();

  const perFile = [];
  let totalOcc = 0;
  for (const rel of files) {
    const abs = path.join(cwd, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    if (isBinary(buf)) continue;
    const text = buf.toString("utf8");
    let updated = text;
    let fileOcc = 0;
    for (const { re, repl } of compiled) {
      re.lastIndex = 0;
      const m = updated.match(re);
      if (!m || !m.length) continue;
      fileOcc += m.length;
      updated = updated.replace(re, repl);
    }
    if (!fileOcc || updated === text) continue;
    const matches = { length: fileOcc };
    const tmp = abs + ".capex-tmp";
    try {
      fs.writeFileSync(tmp, updated, "utf8");
      fs.renameSync(tmp, abs);
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      return { text: `Error writing ${rel}: ${err.message}`, meta: { mode: "replace", files: perFile.length, occurrences: totalOcc } };
    }
    totalOcc += matches.length;
    perFile.push({ rel, count: matches.length });
  }

  if (!perFile.length) {
    const what = specs.map((s) => (s.is_regex ? "/" + s.old_string + "/" : `"${s.old_string}"`)).join(", ");
    return { text: `No occurrences of ${what} found.`, meta: { mode: "replace", files: 0, occurrences: 0 } };
  }

  // Tiny summary. List files (capped) so the model can verify scope, but never
  // echo file contents or the edits themselves.
  const head = `Replaced ${totalOcc} occurrence(s) across ${perFile.length} file(s):`;
  const shown = perFile.slice(0, 30).map((f) => `  ${f.rel} (${f.count})`);
  if (perFile.length > 30) shown.push(`  … and ${perFile.length - 30} more`);
  return {
    text: [head, ...shown].join("\n"),
    meta: { mode: "replace", files: perFile.length, occurrences: totalOcc },
  };
}
