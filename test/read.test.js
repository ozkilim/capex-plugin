import { test, before } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doRead } from "../src/read.js";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-read-"));
  fs.writeFileSync(path.join(dir, "lines.txt"), "one\ntwo\nthree\nfour\nfive\n");
  fs.writeFileSync(path.join(dir, "sample.js"),
    "import x from 'y';\n" +
    "export function alpha(a, b) {\n  const z = a + b;\n  return z;\n}\n" +
    "class Beta {\n  method() {\n    return 42;\n  }\n}\n");
});

test("default read includes line gutters", async () => {
  const r = await doRead({ file: path.join(dir, "lines.txt") });
  assert.match(r.text, /^1: one/m);
  assert.match(r.text, /^3: three/m);
  assert.strictEqual(r.meta.mode, "read");
});

test("offset/limit slices correctly", async () => {
  const r = await doRead({ file: path.join(dir, "lines.txt"), offset: 2, limit: 2 });
  assert.match(r.text, /^2: two/m);
  assert.match(r.text, /^3: three/m);
  assert.ok(!r.text.includes("1: one"));
  assert.ok(!r.text.includes("4: four"));
  assert.strictEqual(r.meta.truncated, true);
});

test("signatures_only keeps signatures and elides bodies", async () => {
  const r = await doRead({ file: path.join(dir, "sample.js"), signatures_only: true });
  assert.match(r.text, /function alpha/);
  assert.match(r.text, /class Beta/);
  assert.ok(r.text.includes("…"), "bodies elided with ellipsis");
  assert.ok(!r.text.includes("const z = a + b"), "body content elided");
  assert.strictEqual(r.meta.mode, "signatures_only");
});

test("non-existent file returns clean error", async () => {
  const r = await doRead({ file: path.join(dir, "nope.txt") });
  assert.match(r.text, /Error reading/);
  assert.strictEqual(r.meta.lines, 0);
});
