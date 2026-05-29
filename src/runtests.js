// RunTests: run the project's test command and return ONLY the failures plus a
// one-line summary. A test runner's full stdout (every passing test, timing,
// coverage) is large OUTPUT that gets billed and then re-billed as cache-read on
// every subsequent turn of a TDD loop. The agent only needs to know: did it
// pass, and if not, which tests failed and why. This returns exactly that.
//
// Multiple runners are supported via a small parser registry: Node's built-in
// runner (spec/TAP), pytest, and jest/vitest. The runner is detected from the
// command string; an unrecognized runner falls back to a short output tail so
// we never dump the whole stream.
import { spawnSync } from "node:child_process";
import path from "node:path";

export const runTestsSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Test command to run (e.g. 'pytest', 'npx jest', 'npx vitest run', 'node --test'). Default: 'node --test'." },
    cwd: { type: "string" },
  },
};

const MAX_FAIL_BLOCKS = 20;
const MAX_TAIL = 40;

// Pick a parser from the command string. Order matters: vitest before jest only
// matters if both appear, which they won't; substring checks are enough.
export function detectRunner(command = "") {
  const c = command.toLowerCase();
  if (c.includes("pytest") || c.includes("py.test")) return "pytest";
  if (c.includes("vitest")) return "vitest";
  if (c.includes("jest")) return "jest";
  return "node";
}

// Parse Node's test output. The default reporter is `spec` (✔/✖ markers and
// `ℹ tests N` counts); the `tap` reporter (`# tests N`, `not ok`) is also
// handled. We pull summary counts and only the FAILING tests + their error.
function num(line, key) {
  // matches "ℹ tests 2", "# tests 2", "tests 2"
  const m = line.match(new RegExp(`^\\W*\\b${key}\\s+(\\d+)\\b`));
  return m ? Number(m[1]) : null;
}

function parseTestOutput(out) {
  const lines = out.split("\n");
  let tests = null, pass = null, fail = null;
  let inFailSection = false;
  const failBlocks = [];
  let cur = null;
  for (const l of lines) {
    let v;
    if ((v = num(l, "tests")) != null) { tests = v; continue; }
    if ((v = num(l, "pass")) != null) { pass = v; continue; }
    if ((v = num(l, "fail")) != null) { fail = v; continue; }
    if (/failing tests:/i.test(l)) { inFailSection = true; continue; }
    // TAP reporter has no "failing tests:" header — capture `not ok` directly.
    const tap = l.match(/^not ok\s+\d+\s*-?\s*(.+?)(?:\s*#.*)?$/);
    if (tap && tap[1]) {
      if (cur) failBlocks.push(cur);
      if (failBlocks.length >= MAX_FAIL_BLOCKS) { cur = null; break; }
      cur = `✗ ${tap[1].trim()}`;
      continue;
    }
    if (!inFailSection) {
      if (cur && /(Error|AssertionError|expected|actual)\b/.test(l) && !cur.includes("\n")) {
        cur += `\n    ${l.trim().slice(0, 200)}`;
      }
      continue;
    }
    // Within the failing-tests section: "✖ name (1.2ms)" starts a block; the
    // first Error line in the block is the useful diagnostic.
    const fm = l.match(/^\s*(?:✖|×|not ok\s+\d+\s*-?)\s*(.+?)(?:\s*\([\d.]+ms\))?\s*$/);
    if (fm && fm[1] && !/failing tests/i.test(fm[1])) {
      if (cur) failBlocks.push(cur);
      if (failBlocks.length >= MAX_FAIL_BLOCKS) { cur = null; break; }
      cur = `✗ ${fm[1].trim()}`;
      continue;
    }
    if (cur && /(Error|AssertionError|expected|actual)\b/.test(l) && !cur.includes("\n")) {
      cur += `\n    ${l.trim().slice(0, 200)}`;
    }
  }
  if (cur) failBlocks.push(cur);
  return { tests, pass, fail, failBlocks };
}

// ===========================================================================
// pytest parser
// ---------------------------------------------------------------------------
// We rely on two stable, default-on pytest features:
//   - the final summary line, e.g. "== 1 failed, 4 passed, 1 error in 0.03s =="
//   - the "short test summary info" section, whose lines look like
//       FAILED tests/test_math.py::test_add - assert 3 == 4
//       ERROR  tests/test_db.py - fixture 'db' not found
// These give counts + which tests failed + a one-line reason, without the giant
// FAILURES traceback section.
export function parsePytest(out) {
  const lines = out.split("\n");
  let failed = null, passed = null, errors = null, skipped = null;
  const failBlocks = [];

  for (const l of lines) {
    // Summary line (surrounded by '=' rules). Pull each "<n> <word>" pair.
    if (/^=+.*\b(passed|failed|error|errors|skipped|xfailed|xpassed)\b.*=+$/.test(l) || /\bin [\d.]+s\b/.test(l)) {
      const grab = (key) => {
        const m = l.match(new RegExp(`(\\d+)\\s+${key}`));
        return m ? Number(m[1]) : null;
      };
      const f = grab("failed"), p = grab("passed"), e = grab("errors?"), s = grab("skipped");
      if (f != null) failed = f;
      if (p != null) passed = p;
      if (e != null) errors = e;
      if (s != null) skipped = s;
    }
    // short test summary info lines.
    const m = l.match(/^(FAILED|ERROR)\s+(\S+)(?:\s+-\s+(.*))?$/);
    if (m) {
      if (failBlocks.length >= MAX_FAIL_BLOCKS) continue;
      const reason = m[3] ? `\n    ${m[3].trim().slice(0, 200)}` : "";
      failBlocks.push(`✗ ${m[2]}${reason}`);
    }
  }

  if (failed == null && passed == null && errors == null && !failBlocks.length) return null;
  const fail = (failed || 0) + (errors || 0);
  const tests = (failed || 0) + (passed || 0) + (errors || 0) + (skipped || 0) || null;
  return { tests, pass: passed, fail, failBlocks };
}

// ===========================================================================
// jest / vitest parser
// ---------------------------------------------------------------------------
// Both print a per-test failure marker (jest: "✕", vitest: "×") and a summary
// line. We capture the failing test names (+ first diagnostic line) and counts.
//   jest:   "Tests:       1 failed, 1 passed, 2 total"
//   vitest: "      Tests  1 failed | 1 passed (2)"
export function parseJestVitest(out) {
  const lines = out.split("\n");
  let fail = null, pass = null, tests = null;
  const failBlocks = [];
  let cur = null;

  const pushCur = () => { if (cur) { failBlocks.push(cur); cur = null; } };

  for (const l of lines) {
    // jest summary
    let m = l.match(/^\s*Tests:\s*(?:(\d+) failed,\s*)?(?:(\d+) passed,\s*)?(?:(\d+) skipped,\s*)?(\d+) total/);
    if (m) {
      fail = m[1] ? Number(m[1]) : 0;
      pass = m[2] ? Number(m[2]) : null;
      tests = Number(m[4]);
      continue;
    }
    // vitest summary: "Tests  1 failed | 1 passed (2)"
    m = l.match(/^\s*Tests\s+(?:(\d+) failed\s*)?(?:\|\s*(\d+) passed\s*)?(?:\|\s*(\d+) skipped\s*)?\((\d+)\)/);
    if (m) {
      fail = m[1] ? Number(m[1]) : 0;
      pass = m[2] ? Number(m[2]) : null;
      tests = Number(m[4]);
      continue;
    }
    // Failing-test marker line (jest ✕, vitest ×, generic ✗). Capture the name.
    const fm = l.match(/^\s*(?:✕|×|✗)\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?\s*$/);
    if (fm && fm[1]) {
      pushCur();
      if (failBlocks.length >= MAX_FAIL_BLOCKS) { cur = null; continue; }
      cur = `✗ ${fm[1].trim()}`;
      continue;
    }
    // First useful diagnostic after a failing marker.
    if (cur && !cur.includes("\n")) {
      const diag = l.match(/(?:→\s*|expect\(|Expected:|AssertionError|Error:)/);
      if (diag) cur += `\n    ${l.trim().slice(0, 200)}`;
    }
  }
  pushCur();

  if (fail == null && pass == null && tests == null && !failBlocks.length) return null;
  return { tests, pass, fail: fail == null ? (failBlocks.length || null) : fail, failBlocks };
}

function parseByRunner(runner, out) {
  if (runner === "pytest") return parsePytest(out);
  if (runner === "jest" || runner === "vitest") return parseJestVitest(out);
  return parseTestOutput(out);
}

export async function doRunTests(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const command = args.command || "node --test";
  const runner = detectRunner(command);
  // Strip the test-runner context so a spawned `node --test` runs as a normal
  // top-level process (otherwise Node propagates NODE_TEST_CONTEXT and the child
  // emits TAP meant for a parent runner).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(command, { cwd, env, encoding: "utf8", shell: true, maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  const parsed = parseByRunner(runner, out) || { tests: null, pass: null, fail: null, failBlocks: [] };
  const exit = r.status ?? (r.error ? 1 : 0);

  // Happy path: parsed counts and nothing failed.
  if (parsed.fail === 0 && parsed.tests != null) {
    return {
      text: `PASS — ${parsed.pass ?? parsed.tests}/${parsed.tests} tests passed.`,
      meta: { mode: "runtests", runner, passed: true, failures: 0, tests: parsed.tests },
    };
  }

  if (parsed.fail != null && parsed.fail > 0 && parsed.failBlocks.length) {
    const head = `FAIL — ${parsed.fail}/${parsed.tests ?? "?"} test(s) failed:`;
    return {
      text: [head, ...parsed.failBlocks].join("\n"),
      meta: { mode: "runtests", runner, passed: false, failures: parsed.fail, tests: parsed.tests },
    };
  }

  // Couldn't parse (unrecognized runner, crash, compile error): return a small
  // tail of the output rather than the whole thing.
  const tail = out.split("\n").filter(Boolean).slice(-MAX_TAIL).join("\n");
  return {
    text: `${exit === 0 ? "Tests finished" : "Test command exited " + exit} (could not parse ${runner} output). Last lines:\n${tail}`,
    meta: { mode: "runtests", runner, passed: exit === 0, failures: exit === 0 ? 0 : null, tests: parsed.tests },
  };
}
