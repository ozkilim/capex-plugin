import fs from "node:fs";
import path from "node:path";

export const editSchema = {
  type: "object",
  required: ["edits"],
  properties: {
    edits: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["file", "old_string", "new_string"],
        properties: {
          file: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean", default: false }
        }
      }
    }
  }
};

// Collapse runs of horizontal whitespace to a single space, tracking a map
// from each position in the normalized string back to the original index.
function normalizeWithMap(text) {
  let norm = "";
  const map = []; // map[i] = original index of norm[i]
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      // collapse the whole horizontal-whitespace run to a single space
      const runStart = i;
      while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
      norm += " ";
      map.push(runStart);
    } else {
      norm += ch;
      map.push(i);
      i++;
    }
  }
  map.push(text.length); // sentinel for end
  return { norm, map };
}

function normalizeNeedle(s) {
  return s.replace(/[ \t]+/g, " ");
}

// Find all match ranges (in original text indices) of needle in text using
// whitespace-fuzzy matching. Newlines are preserved verbatim.
function findFuzzyRanges(text, needle) {
  const { norm, map } = normalizeWithMap(text);
  const nNeedle = normalizeNeedle(needle);
  const ranges = [];
  if (nNeedle.length === 0) return ranges;
  let from = 0;
  while (true) {
    const idx = norm.indexOf(nNeedle, from);
    if (idx === -1) break;
    const startOrig = map[idx];
    const endOrig = map[idx + nNeedle.length]; // exclusive
    ranges.push([startOrig, endOrig]);
    from = idx + nNeedle.length;
  }
  return ranges;
}

function applyEditsToText(text, fileEdits) {
  // Apply edits sequentially; each edit re-scans the current text.
  let cur = text;
  for (const e of fileEdits) {
    const ranges = findFuzzyRanges(cur, e.old_string);
    if (ranges.length === 0) {
      throw new Error(`No match for old_string in ${e.file}`);
    }
    if (!e.replace_all && ranges.length > 1) {
      throw new Error(`Found ${ranges.length} matches for old_string in ${e.file}; use replace_all or a more specific string`);
    }
    const targets = e.replace_all ? ranges : [ranges[0]];
    // Replace from last to first to keep indices valid.
    for (let k = targets.length - 1; k >= 0; k--) {
      const [s, en] = targets[k];
      cur = cur.slice(0, s) + e.new_string + cur.slice(en);
    }
  }
  return cur;
}

export async function doEdit(args = {}) {
  const edits = args.edits || [];
  const byFile = new Map();
  for (const e of edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }

  const summaries = [];
  for (const [file, fileEdits] of byFile) {
    const abs = path.resolve(file);
    const original = fs.readFileSync(abs, "utf8");
    let updated;
    try {
      updated = applyEditsToText(original, fileEdits);
    } catch (err) {
      // Nothing was written for this file yet, so no rollback needed; rethrow.
      throw err;
    }
    // Atomic write via temp file; on failure leave original intact.
    const tmp = abs + ".capex-tmp";
    try {
      fs.writeFileSync(tmp, updated, "utf8");
      fs.renameSync(tmp, abs);
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      // Ensure original content is preserved.
      try { fs.writeFileSync(abs, original, "utf8"); } catch {}
      throw err;
    }
    summaries.push(`${file}: applied ${fileEdits.length} edit(s)`);
  }

  return {
    text: summaries.join("\n"),
    meta: { batchSize: edits.length, filesTouched: byFile.size, mode: "edit" }
  };
}
