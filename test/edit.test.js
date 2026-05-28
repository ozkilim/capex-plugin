import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doEdit } from "../src/edit.js";

let dir;
function f(name) { return path.join(dir, name); }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-edit-"));
});
after(() => { /* temp dirs cleaned by OS */ });

test("single edit applies and persists", async () => {
  fs.writeFileSync(f("a.txt"), "hello world\n");
  const r = await doEdit({ edits: [{ file: f("a.txt"), old_string: "world", new_string: "there" }] });
  assert.strictEqual(r.meta.batchSize, 1);
  assert.strictEqual(fs.readFileSync(f("a.txt"), "utf8"), "hello there\n");
});

test("multi-edit across two files writes each once", async () => {
  fs.writeFileSync(f("a.txt"), "foo\n");
  fs.writeFileSync(f("b.txt"), "bar\n");
  const r = await doEdit({ edits: [
    { file: f("a.txt"), old_string: "foo", new_string: "FOO" },
    { file: f("b.txt"), old_string: "bar", new_string: "BAR" }
  ] });
  assert.strictEqual(r.meta.filesTouched, 2);
  assert.strictEqual(fs.readFileSync(f("a.txt"), "utf8"), "FOO\n");
  assert.strictEqual(fs.readFileSync(f("b.txt"), "utf8"), "BAR\n");
});

test("whitespace-fuzzy match across differing indentation", async () => {
  // File is indented with 6 spaces; old_string uses 2-space indentation.
  // Horizontal whitespace is collapsed for matching; newlines preserved verbatim.
  fs.writeFileSync(f("a.txt"), "if (x) {\n      doThing();\n}\n");
  const r = await doEdit({ edits: [{ file: f("a.txt"), old_string: "if (x) {\n  doThing();\n}", new_string: "if (y) {\n  doOther();\n}" }] });
  assert.ok(r.text.includes("applied"));
  assert.strictEqual(fs.readFileSync(f("a.txt"), "utf8"), "if (y) {\n  doOther();\n}\n");
});

test("zero-match errors", async () => {
  fs.writeFileSync(f("a.txt"), "hello\n");
  await assert.rejects(() => doEdit({ edits: [{ file: f("a.txt"), old_string: "nope", new_string: "x" }] }), /No match/);
  assert.strictEqual(fs.readFileSync(f("a.txt"), "utf8"), "hello\n");
});

test("multiple matches without replace_all errors", async () => {
  fs.writeFileSync(f("a.txt"), "x x x\n");
  await assert.rejects(() => doEdit({ edits: [{ file: f("a.txt"), old_string: "x", new_string: "y" }] }), /matches/);
});

test("replace_all replaces every occurrence", async () => {
  fs.writeFileSync(f("a.txt"), "x x x\n");
  await doEdit({ edits: [{ file: f("a.txt"), old_string: "x", new_string: "y", replace_all: true }] });
  assert.strictEqual(fs.readFileSync(f("a.txt"), "utf8"), "y y y\n");
});

test("failure on second edit of a file rolls back the first", async () => {
  fs.writeFileSync(f("a.txt"), "alpha beta\n");
  await assert.rejects(() => doEdit({ edits: [
    { file: f("a.txt"), old_string: "alpha", new_string: "ALPHA" },
    { file: f("a.txt"), old_string: "nonexistent", new_string: "X" }
  ] }), /No match/);
  assert.strictEqual(fs.readFileSync(f("a.txt"), "utf8"), "alpha beta\n");
});
