import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doRefs, doDef } from "../src/refs.js";
import { findReferences, findDefinitions } from "../src/ast.js";

function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-refs-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

const PROJECT = {
  "src/money.js": "export function calcTotal(items){ return items.length }\n",
  "src/cart.js": "import { calcTotal } from './money.js'\nexport function cartTotal(c){ return calcTotal(c.lines) }\n",
  "src/order.js": "import { calcTotal } from './money.js'\nconst t = calcTotal([])\n// calcTotal is referenced in this comment but NOT as code\n",
};

test("findDefinitions locates the declaration", async () => {
  const dir = tmp(PROJECT);
  const defs = await findDefinitions(path.join(dir, "src/money.js"), "calcTotal");
  assert.strictEqual(defs.length, 1);
  assert.strictEqual(defs[0].line, 1);
});

test("findReferences finds code usages but not comment text", async () => {
  const dir = tmp(PROJECT);
  const refs = await findReferences(path.join(dir, "src/order.js"), "calcTotal");
  // import + call = 2 real refs; the comment mention must NOT match (AST-precise)
  assert.strictEqual(refs.length, 2);
});

test("doDef across glob returns the defining file", async () => {
  const dir = tmp(PROJECT);
  const r = await doDef({ cwd: dir, symbol: "calcTotal", file_glob_patterns: ["src/**/*.js"] });
  assert.strictEqual(r.meta.mode, "def");
  assert.strictEqual(r.meta.defs, 1);
  assert.match(r.text, /src\/money\.js/);
});

test("doRefs across glob aggregates call sites by file", async () => {
  const dir = tmp(PROJECT);
  const r = await doRefs({ cwd: dir, symbol: "calcTotal", file_glob_patterns: ["src/**/*.js"] });
  assert.strictEqual(r.meta.mode, "refs");
  // money(def) + cart(import+call) + order(import+call) = 5 occurrences
  assert.ok(r.meta.refs >= 4, `expected >=4 refs, got ${r.meta.refs}`);
  assert.ok(r.meta.files >= 3);
});

test("doRefs with unknown symbol is graceful", async () => {
  const dir = tmp(PROJECT);
  const r = await doRefs({ cwd: dir, symbol: "nonexistentXYZ", file_glob_patterns: ["src/**/*.js"] });
  assert.strictEqual(r.meta.refs, 0);
});
