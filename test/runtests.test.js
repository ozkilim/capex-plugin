import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doRunTests, detectRunner, parsePytest, parseJestVitest } from "../src/runtests.js";

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

// ---- runner detection -----------------------------------------------------
test("detectRunner identifies the runner from the command", () => {
  assert.strictEqual(detectRunner("pytest -q"), "pytest");
  assert.strictEqual(detectRunner("python -m pytest"), "pytest");
  assert.strictEqual(detectRunner("npx vitest run"), "vitest");
  assert.strictEqual(detectRunner("npx jest"), "jest");
  assert.strictEqual(detectRunner("node --test"), "node");
  assert.strictEqual(detectRunner(undefined), "node");
});

// ---- pytest ---------------------------------------------------------------
const PYTEST_FAIL = `============================= test session starts ==============================
platform linux -- Python 3.11.0, pytest-7.4.0, pluggy-1.0.0
collected 5 items

tests/test_math.py ..F..                                                 [100%]

=================================== FAILURES ===================================
_________________________________ test_add ____________________________________

    def test_add():
>       assert add(1, 2) == 4
E       assert 3 == 4
E        +  where 3 = add(1, 2)

tests/test_math.py:8: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_add - assert 3 == 4
========================= 1 failed, 4 passed in 0.03s ==========================`;

const PYTEST_PASS = `============================= test session starts ==============================
collected 3 items

tests/test_ok.py ...                                                     [100%]

============================== 3 passed in 0.01s ===============================`;

test("parsePytest extracts counts and only the failing test", () => {
  const p = parsePytest(PYTEST_FAIL);
  assert.strictEqual(p.fail, 1);
  assert.strictEqual(p.pass, 4);
  assert.strictEqual(p.tests, 5);
  assert.strictEqual(p.failBlocks.length, 1);
  assert.match(p.failBlocks[0], /test_add/);
  assert.match(p.failBlocks[0], /assert 3 == 4/);
  // The giant traceback must NOT be carried through.
  assert.ok(!p.failBlocks.join("\n").includes("where 3 = add"));
});

test("parsePytest handles an all-pass run", () => {
  const p = parsePytest(PYTEST_PASS);
  assert.strictEqual(p.fail, 0);
  assert.strictEqual(p.pass, 3);
  assert.strictEqual(p.tests, 3);
  assert.strictEqual(p.failBlocks.length, 0);
});

test("doRunTests on pytest output is failures-only and small", async () => {
  // Echo a captured pytest run instead of needing pytest installed.
  const script = `cat <<'EOF'\n${PYTEST_FAIL}\nEOF`;
  // "pytest" in the command drives runner detection; we don't actually invoke it.
  const r = await doRunTests({ command: `echo pytest >/dev/null; ${script}` });
  assert.strictEqual(r.meta.runner, "pytest");
  assert.strictEqual(r.meta.passed, false);
  assert.strictEqual(r.meta.failures, 1);
  assert.match(r.text, /FAIL/);
  assert.match(r.text, /test_add/);
  assert.ok(!r.text.includes("test session starts"), "strips the session banner");
});

// ---- jest / vitest --------------------------------------------------------
const JEST_FAIL = ` FAIL  src/sum.test.js
  ✓ adds 1 + 2 (3 ms)
  ✕ adds wrong (1 ms)

  ● adds wrong

    expect(received).toBe(expected)

    Expected: 4
    Received: 3

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 passed, 2 total
Snapshots:   0 total
Time:        1.2 s`;

const VITEST_FAIL = ` ❯ src/sum.test.ts (2)
   × adds wrong
     → expected 3 to be 4

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  10:00:00
   Duration  120ms`;

test("parseJestVitest parses jest output", () => {
  const p = parseJestVitest(JEST_FAIL);
  assert.strictEqual(p.fail, 1);
  assert.strictEqual(p.pass, 1);
  assert.strictEqual(p.tests, 2);
  assert.ok(p.failBlocks.some((b) => /adds wrong/.test(b)));
});

test("parseJestVitest parses vitest output", () => {
  const p = parseJestVitest(VITEST_FAIL);
  assert.strictEqual(p.fail, 1);
  assert.strictEqual(p.pass, 1);
  assert.strictEqual(p.tests, 2);
  assert.ok(p.failBlocks.some((b) => /adds wrong/.test(b)));
});

test("doRunTests on jest output reports the failure compactly", async () => {
  const script = `cat <<'EOF'\n${JEST_FAIL}\nEOF`;
  // "jest" in the command drives runner detection; we don't actually invoke it.
  const r = await doRunTests({ command: `echo jest >/dev/null; ${script}` });
  assert.strictEqual(r.meta.runner, "jest");
  assert.strictEqual(r.meta.passed, false);
  assert.strictEqual(r.meta.failures, 1);
  assert.match(r.text, /adds wrong/);
  assert.ok(!r.text.includes("Snapshots:"), "drops the snapshot/time noise");
});
