import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doSearch } from "../src/search.js";

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-search-"));
  fs.writeFileSync(path.join(dir, "a.js"), "import fs from 'fs';\nconst x = processOrder();\n");
  fs.writeFileSync(path.join(dir, "b.js"), "function processOrder() { return 1; }\n// processOrder again\n");
  fs.writeFileSync(path.join(dir, "c.txt"), "nothing here\n");
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.writeFileSync(path.join(dir, "node_modules", "d.js"), "processOrder in node_modules\n");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "e.js"), "processOrder in git\n");
  // binary file
  fs.writeFileSync(path.join(dir, "bin.js"), Buffer.from([0x70, 0x00, 0x72, 0x6f]));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("file_glob_patterns only returns file list", async () => {
  const r = await doSearch({ file_glob_patterns: ["*.js"], cwd: dir });
  assert.strictEqual(r.meta.mode, "search");
  assert.ok(r.text.includes("a.js"));
  assert.ok(r.text.includes("b.js"));
  assert.ok(!r.text.includes(":"), "no line numbers without regex");
});

test("content_regex returns matches with line numbers and context", async () => {
  const r = await doSearch({ file_glob_patterns: ["*.js"], content_regex: "processOrder", cwd: dir });
  assert.ok(r.meta.matches >= 2);
  assert.match(r.text, /a\.js:2/);
  assert.match(r.text, /^> /m);
});

test("max_results caps output", async () => {
  const r = await doSearch({ file_glob_patterns: ["*.js"], content_regex: "processOrder", max_results: 1, cwd: dir });
  assert.strictEqual(r.meta.matches, 1);
  assert.strictEqual(r.meta.capped, true);
});

test("binary files are skipped", async () => {
  const r = await doSearch({ file_glob_patterns: ["*.js"], content_regex: "pro", cwd: dir });
  assert.ok(!r.text.includes("bin.js"));
});

test("node_modules and .git excluded by default", async () => {
  const r = await doSearch({ file_glob_patterns: ["**/*.js"], content_regex: "processOrder", cwd: dir });
  assert.ok(!r.text.includes("node_modules"));
  assert.ok(!r.text.includes(".git"));
});
