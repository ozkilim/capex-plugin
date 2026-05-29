import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doOutline } from "../src/outline.js";
import { langForFile, outlineFile } from "../src/ast.js";

function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-outline-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

test("langForFile maps extensions", () => {
  assert.strictEqual(langForFile("a.js"), "javascript");
  assert.strictEqual(langForFile("a.ts"), "typescript");
  assert.strictEqual(langForFile("a.py"), "python");
  assert.strictEqual(langForFile("a.rs"), "rust");
  assert.strictEqual(langForFile("a.unknownext"), null);
});

test("outlineFile extracts JS symbols with line numbers", async () => {
  const dir = tmp({ "m.js": "export function add(a,b){return a+b}\nclass Box{ open(){} }\n" });
  const syms = await outlineFile(path.join(dir, "m.js"));
  const names = syms.map((s) => s.name).sort();
  assert.deepStrictEqual(names, ["Box", "add", "open"].sort());
  const add = syms.find((s) => s.name === "add");
  assert.strictEqual(add.line, 1);
  assert.strictEqual(add.kind, "function");
});

test("outlineFile returns null for unsupported language", async () => {
  const dir = tmp({ "x.unknownext": "blah" });
  assert.strictEqual(await outlineFile(path.join(dir, "x.unknownext")), null);
});

test("doOutline over a glob returns terse text + meta", async () => {
  const dir = tmp({
    "src/a.js": "export const f = (n) => n+1\n",
    "src/b.py": "def g(x):\n    return x\n",
  });
  const r = await doOutline({ cwd: dir, file_glob_patterns: ["src/**/*"] });
  assert.strictEqual(r.meta.mode, "outline");
  assert.strictEqual(r.meta.files, 2);
  assert.ok(r.meta.symbols >= 2);
  assert.match(r.text, /src\/a\.js/);
  assert.match(r.text, /g\(x\)/);
});

test("doOutline with no matches is graceful", async () => {
  const dir = tmp({ "readme.md": "# hi" });
  const r = await doOutline({ cwd: dir, file_glob_patterns: ["**/*.md"] });
  assert.strictEqual(r.meta.symbols, 0);
});
