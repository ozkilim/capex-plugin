// RunTests: run the project's test command and return ONLY the failures plus a
// one-line summary. A test runner's full stdout (every passing test, timing,
// coverage) is large OUTPUT that gets billed and then re-billed as cache-read on
// every subsequent turn of a TDD loop. The agent only needs to know: did it
// pass, and if not, which tests failed and why. This returns exactly that.
import { spawnSync } from "node:child_process";
import path from "node:path";

export const runTestsSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Test command to run. Default: 'node --test'." },
    cwd: { type: "string" },
  },
};

const MAX_FAIL_BLOCKS = 20;
const MAX_TAIL = 40;

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

export async function doRunTests(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const command = args.command || "node --test";
  // Strip the test-runner context so a spawned `node --test` runs as a normal
  // top-level process (otherwise Node propagates NODE_TEST_CONTEXT and the child
  // emits TAP meant for a parent runner).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(command, { cwd, env, encoding: "utf8", shell: true, maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || "") + "\n" + (r.stderr || "");
  const parsed = parseTestOutput(out);
  const exit = r.status ?? (r.error ? 1 : 0);

  // Happy path: parsed counts and nothing failed.
  if (parsed.fail === 0 && parsed.tests != null) {
    return {
      text: `PASS — ${parsed.pass ?? parsed.tests}/${parsed.tests} tests passed.`,
      meta: { mode: "runtests", passed: true, failures: 0, tests: parsed.tests },
    };
  }

  if (parsed.fail != null && parsed.failBlocks.length) {
    const head = `FAIL — ${parsed.fail}/${parsed.tests ?? "?"} test(s) failed:`;
    return {
      text: [head, ...parsed.failBlocks].join("\n"),
      meta: { mode: "runtests", passed: false, failures: parsed.fail, tests: parsed.tests },
    };
  }

  // Couldn't parse (non-TAP runner, crash, compile error): return a small tail
  // of the output rather than the whole thing.
  const tail = out.split("\n").filter(Boolean).slice(-MAX_TAIL).join("\n");
  return {
    text: `${exit === 0 ? "Tests finished" : "Test command exited " + exit} (could not parse TAP). Last lines:\n${tail}`,
    meta: { mode: "runtests", passed: exit === 0, failures: exit === 0 ? 0 : null, tests: parsed.tests },
  };
}
