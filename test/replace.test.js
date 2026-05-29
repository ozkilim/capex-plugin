import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doReplace } from "../src/replace.js";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-replace-"));
  fs.writeFileSync(path.join(dir, "a.js"), "computeTotal(x);\nconst computeTotalish = 1;\n// computeTotal again\n");
  fs.writeFileSync(path.join(dir, "b.js"), "import { computeTotal } from './a.js';\ncomputeTotal();\n");
  fs.writeFileSync(path.join(dir, "c.txt"), "no symbol here\n");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("word_boundary replace renames only whole symbol, across files", async () => {
  const r = await doReplace({ old_string: "computeTotal", new_string: "calcTotal", word_boundary: true, cwd: dir });
  assert.strictEqual(r.meta.mode, "replace");
  assert.strictEqual(r.meta.files, 2);
  // a.js: 2 (call + comment), b.js: 2 (import + call) = 4; "computeTotalish" untouched
  assert.strictEqual(r.meta.occurrences, 4);
  const a = fs.readFileSync(path.join(dir, "a.js"), "utf8");
  assert.ok(a.includes("calcTotal(x)"));
  assert.ok(a.includes("computeTotalish"), "boundary protected the substring");
  // Output is a tiny summary, not the file contents.
  assert.ok(r.text.startsWith("Replaced 4 occurrence"));
  assert.ok(!r.text.includes("import"), "must not echo file contents");
});

test("no match returns a clear summary and edits nothing", async () => {
  const r = await doReplace({ old_string: "nonexistent_zzz", new_string: "x", cwd: dir });
  assert.strictEqual(r.meta.occurrences, 0);
  assert.match(r.text, /No occurrences/);
});

test("regex mode with backrefs", async () => {
  const r = await doReplace({ old_string: "calc(\\w+)", new_string: "do$1", is_regex: true, cwd: dir });
  assert.ok(r.meta.occurrences >= 1);
  assert.ok(fs.readFileSync(path.join(dir, "a.js"), "utf8").includes("doTotal"));
});
