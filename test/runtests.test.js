import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doRunTests } from "../src/runtests.js";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-runtests-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("RunTests reports PASS with counts and no per-test noise", async () => {
  fs.writeFileSync(
    path.join(dir, "ok.test.js"),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\n" +
      "test('one', () => assert.ok(true));\ntest('two', () => assert.strictEqual(1,1));\n"
  );
  const r = await doRunTests({ cwd: dir });
  assert.strictEqual(r.meta.mode, "runtests");
  assert.strictEqual(r.meta.passed, true);
  assert.match(r.text, /PASS/);
  // Terse: should not contain the runner's full TAP stream.
  assert.ok(!r.text.includes("TAP version"));
});

test("RunTests returns only the failing tests", async () => {
  fs.writeFileSync(
    path.join(dir, "bad.test.js"),
    "import { test } from 'node:test';\nimport assert from 'node:assert';\n" +
      "test('passes', () => assert.ok(true));\ntest('breaks', () => assert.strictEqual(1,2));\n"
  );
  const r = await doRunTests({ cwd: dir });
  assert.strictEqual(r.meta.passed, false);
  assert.ok(r.meta.failures >= 1);
  assert.match(r.text, /FAIL/);
  assert.ok(/breaks/.test(r.text), "names the failing test");
});
