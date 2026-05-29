import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doMap } from "../src/map.js";
import { doImports } from "../src/imports.js";
import { doInsert } from "../src/insert.js";
import { doWhere } from "../src/where.js";
import { doRun } from "../src/run.js";
import { doReplace } from "../src/replace.js";
import { doRead } from "../src/read.js";
import { doEdit } from "../src/edit.js";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-r3-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/logger.js"), "export const logger = { info(){} };\n");
  fs.writeFileSync(
    path.join(dir, "src/money.js"),
    "import { logger } from './logger.js';\nexport function computeTotal(items){ logger.info(); return items.length; }\nexport function formatUSD(n){ return '$'+n; }\n"
  );
  fs.writeFileSync(
    path.join(dir, "src/app.js"),
    "import { computeTotal } from './money.js';\nconst x = computeTotal([1,2]);\nexport function run(){ return computeTotal([]); }\n"
  );
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("Map returns a per-file symbol skeleton", async () => {
  const r = await doMap({ cwd: dir });
  assert.strictEqual(r.meta.mode, "map");
  assert.ok(r.text.includes("src/money.js"));
  assert.ok(r.text.includes("computeTotal"));
  assert.ok(r.text.includes("formatUSD"));
  // No function bodies leak.
  assert.ok(!r.text.includes("return items.length"));
  assert.ok(r.meta.sourceFiles >= 3);
});

test("Imports finds importers of a module and a file's imports", async () => {
  const a = await doImports({ module: "money", cwd: dir });
  assert.ok(a.text.includes("src/app.js"), "app imports money");
  assert.ok(!a.text.includes("src/logger.js"));
  const b = await doImports({ of_file: "src/money.js", cwd: dir });
  assert.ok(/logger/.test(b.text));
  assert.strictEqual(b.meta.edges, 1);
});

test("Where fuses definition + call sites", async () => {
  const r = await doWhere({ symbol: "computeTotal", cwd: dir });
  assert.ok(/DEFINITION/.test(r.text));
  assert.ok(r.meta.defs >= 1);
  assert.ok(r.meta.refs >= 2, "call sites in app.js");
  assert.ok(r.meta.files >= 1);
});

test("Insert adds code after a symbol and reports parse status", async () => {
  const r = await doInsert({ file: "src/money.js", after_symbol: "computeTotal", content: "export function half(n){ return n/2; }", cwd: dir });
  assert.strictEqual(r.meta.inserted, true);
  assert.ok(/parses/.test(r.text));
  const src = fs.readFileSync(path.join(dir, "src/money.js"), "utf8");
  assert.ok(src.includes("function half"));
});

test("Run suppresses output on success, surfaces errors on failure", async () => {
  // Output token ('QQWW') is not present contiguously in the command string,
  // so finding it in the result would mean real stdout leaked through.
  const ok = await doRun({ command: "node -e \"console.log('QQ'+'WW')\"", cwd: dir });
  assert.strictEqual(ok.meta.exit, 0);
  assert.ok(!ok.text.includes("QQWW"), "passing output suppressed");
  assert.ok(/suppressed/.test(ok.text));
  const bad = await doRun({ command: "echo 'Error: boom' && exit 3", cwd: dir });
  assert.strictEqual(bad.meta.exit, 3);
  assert.ok(/boom/.test(bad.text));
});

test("Replace multi-pattern renames several symbols in one call", async () => {
  const r = await doReplace({
    replacements: [
      { old_string: "computeTotal", new_string: "calcTotal", word_boundary: true },
      { old_string: "formatUSD", new_string: "fmtUSD", word_boundary: true },
    ],
    cwd: dir,
  });
  assert.ok(r.meta.occurrences >= 4);
  assert.ok(fs.readFileSync(path.join(dir, "src/money.js"), "utf8").includes("calcTotal"));
  assert.ok(fs.readFileSync(path.join(dir, "src/money.js"), "utf8").includes("fmtUSD"));
});

test("Read code_only drops comment/blank lines", async () => {
  const f = path.join(dir, "src/commented.js");
  fs.writeFileSync(f, "// a comment\n\nexport const z = 1;\n// trailing\n");
  const r = await doRead({ file: f, code_only: true });
  assert.ok(r.text.includes("export const z"));
  assert.ok(!r.text.includes("a comment"));
  assert.strictEqual(r.meta.codeOnly, true);
});

test("Edit reports a syntax error it introduced", async () => {
  const f = path.join(dir, "src/breakme.js");
  fs.writeFileSync(f, "export function ok(){ return 1; }\n");
  const r = await doEdit({ edits: [{ file: f, old_string: "return 1; }", new_string: "return 1; " }] });
  assert.ok(/syntax error/.test(r.text), "should flag the broken brace");
});
