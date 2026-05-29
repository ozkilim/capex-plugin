// Benchmark tasks. The headline set is REALISTIC multi-step coding-agent work:
// the agent must explore the repo, edit across several files, and not break it.
// This is where token cost actually accumulates (many turns of read+search+edit)
// and where CAPEX either compounds savings or compounds overhead.
//
// Each task is phrased identically for both arms (CAPEX vs stock); both have the
// full real toolset (Bash, subagents, etc.) — we measure the realistic product,
// not a lab-isolated tool. `verify(dir)` runs against the post-task working copy
// and must confirm the work was actually done AND the repo still parses, so a
// cheap run that didn't really do the task is flagged ✗.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function read(dir, rel) {
  try { return fs.readFileSync(path.join(dir, rel), "utf8"); } catch { return ""; }
}
function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}
// `node --check` every given file: catches syntax breakage the agent introduced.
function parses(dir, rels) {
  for (const rel of rels) {
    if (!exists(dir, rel)) return { ok: false, reason: `${rel} missing` };
    const r = spawnSync("node", ["--check", path.join(dir, rel)], { encoding: "utf8" });
    if (r.status !== 0) return { ok: false, reason: `${rel} does not parse` };
  }
  return { ok: true };
}
// Run a small ESM assertion script inside the working copy (exit 0 = pass).
function assertScript(dir, body) {
  const r = spawnSync("node", ["--input-type=module", "-e", body], { cwd: dir, encoding: "utf8" });
  if (r.status === 0) return { ok: true };
  const errLine = (r.stderr || "").split("\n").find((l) => /Error:/.test(l));
  return { ok: false, reason: (errLine || "assertion failed").trim() };
}
function walkJs(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(abs, base, out);
    else if (e.name.endsWith(".js")) out.push(path.relative(base, abs));
  }
  return out;
}

// A modest module count: enough that the agent must actually search/navigate a
// real-feeling repo, not so much that runs cost a fortune.
const REPO = 15;

export const tasks = [
  // ===== REALISTIC multi-step coding tasks (default set) ====================
  {
    id: "feat-currency",
    modules: REPO,
    maxTurns: 40,
    optimizes: "multi-file feature: explore + edit across files",
    prompt:
      "Add multi-currency support to this billing repo. " +
      "1) Add an optional `currency` parameter (default \"USD\") to `createOrder` in " +
      "src/services/orders.js and to `buildInvoice` in src/services/invoice.js, and store " +
      "it on the object each returns. " +
      "2) Make `formatUSD` in src/util/money.js take an optional currency code and use the " +
      "right symbol ($ for USD, € for EUR, £ for GBP), keeping USD the default so existing " +
      "callers are unaffected. " +
      "Keep everything syntactically valid.",
    verify(dir) {
      const p = parses(dir, ["src/services/orders.js", "src/services/invoice.js", "src/util/money.js", "src/index.js"]);
      if (!p.ok) return p;
      for (const f of ["src/services/orders.js", "src/services/invoice.js", "src/util/money.js"]) {
        if (!/currency/i.test(read(dir, f))) return { ok: false, reason: `no currency handling in ${f}` };
      }
      return assertScript(
        dir,
        "import { formatUSD } from './src/util/money.js';" +
        "if(!formatUSD(5).includes('$')) throw new Error('USD default broke');" +
        "const eur=formatUSD(5,'EUR'); if(!/€/.test(eur)) throw new Error('EUR symbol missing');"
      );
    },
  },
  {
    id: "bugfix-clamp",
    modules: REPO,
    maxTurns: 35,
    optimizes: "locate + fix a bug across files",
    prompt:
      "There are two bugs to fix. " +
      "1) `applyDiscount(total, pct)` in src/util/money.js can return a value greater than " +
      "`total` (for negative pct) or below 0 (for pct > 100). Clamp its result to the range " +
      "[0, total]. " +
      "2) `cartTotal` in src/services/cart.js must ignore any discount percentage above 100 " +
      "(treat it as 0). Fix both without breaking existing behavior for valid inputs.",
    verify(dir) {
      const p = parses(dir, ["src/util/money.js", "src/services/cart.js"]);
      if (!p.ok) return p;
      return assertScript(
        dir,
        "import { applyDiscount } from './src/util/money.js';" +
        "if(applyDiscount(100,150) < 0) throw new Error('not clamped at 0');" +
        "if(applyDiscount(100,-50) > 100) throw new Error('not clamped at total');"
      );
    },
  },
  {
    id: "add-service",
    modules: REPO,
    maxTurns: 35,
    optimizes: "create new module + wire it in, matching patterns",
    prompt:
      "Add a refunds feature following the existing service patterns. Create " +
      "src/services/refunds.js that exports `computeRefund(order, pct)` — it should reuse " +
      "`computeTotal`/`applyDiscount` from src/util/money.js and log via the shared logger, " +
      "like the other services do. Then export `computeRefund` from src/index.js. " +
      "Keep everything syntactically valid.",
    verify(dir) {
      if (!exists(dir, "src/services/refunds.js")) return { ok: false, reason: "refunds.js not created" };
      const p = parses(dir, ["src/services/refunds.js", "src/index.js"]);
      if (!p.ok) return p;
      if (!/computeRefund/.test(read(dir, "src/services/refunds.js"))) return { ok: false, reason: "computeRefund not exported" };
      if (!/refunds/.test(read(dir, "src/index.js"))) return { ok: false, reason: "not wired into index.js" };
      return assertScript(dir, "import { computeRefund } from './src/index.js'; if(typeof computeRefund!=='function') throw new Error('not exported from index');");
    },
  },
  {
    id: "add-tests",
    modules: 0,
    maxTurns: 35,
    optimizes: "read code + author a passing test file",
    prompt:
      "Add unit tests for the money helpers. Create a test file using node:test that covers " +
      "`computeTotal`, `applyDiscount`, and `formatUSD` from src/util/money.js with a few " +
      "assertions each. The tests must pass when run with `node --test`.",
    verify(dir) {
      const tests = walkJs(path.join(dir, "src"), dir).filter((f) => /test/i.test(f));
      if (!tests.length) return { ok: false, reason: "no test file created" };
      const r = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) return { ok: false, reason: "node --test failed" };
      if (!/tests \d+/.test(r.stdout) || /tests 0/.test(r.stdout)) return { ok: false, reason: "no tests ran" };
      return { ok: true };
    },
  },

  {
    id: "api-docs",
    modules: 30,
    maxTurns: 30,
    optimizes: "AST Outline: map many files' structure cheaply",
    prompt:
      "Produce an API summary of this repo. For every .js file under src/, list the file path " +
      "and the names of the functions and classes it defines. Output one short section per file. " +
      "Do not edit any files.",
    expectMentions: ["computeTotal", "createOrder", "handle000", "handle020"],
  },

  // ===== Micro-op tasks (kept for tool-level probing; not the default) ======
  {
    id: "batch-rename-lg",
    modules: 24,
    maxTurns: 70,
    optimizes: "micro: batched Edit at scale",
    prompt:
      "Rename the function `computeTotal` to `calcTotal` throughout this entire repo — " +
      "its definition in src/util/money.js and every import and call site in all files, " +
      "including everything under src/mod/. Apply the edits to the files.",
    verify(dir) {
      const files = walkJs(path.join(dir, "src"), dir);
      const stragglers = files.filter((f) => /\bcomputeTotal\b/.test(read(dir, f)));
      if (stragglers.length) return { ok: false, reason: `computeTotal left in ${stragglers.length} file(s)` };
      if (!/\bcalcTotal\b/.test(read(dir, "src/util/money.js"))) return { ok: false, reason: "calcTotal not defined" };
      return { ok: true };
    },
  },
  {
    // Orientation-heavy: the task touches a few specific files but they're
    // buried in a 40-module repo, so the agent must navigate a large tree.
    // This is where cold-start tools (Map/Imports/Where) should earn their keep.
    id: "add-service-lg",
    modules: 40,
    maxTurns: 40,
    optimizes: "R3: orient in a large repo + create/wire a module",
    prompt:
      "Add a refunds feature following the existing service patterns. Create " +
      "src/services/refunds.js that exports `computeRefund(order, pct)` — it should reuse " +
      "`computeTotal`/`applyDiscount` from src/util/money.js and log via the shared logger, " +
      "like the other services do. Then export `computeRefund` from src/index.js. " +
      "Keep everything syntactically valid.",
    verify(dir) {
      if (!exists(dir, "src/services/refunds.js")) return { ok: false, reason: "refunds.js not created" };
      const p = parses(dir, ["src/services/refunds.js", "src/index.js"]);
      if (!p.ok) return p;
      if (!/computeRefund/.test(read(dir, "src/services/refunds.js"))) return { ok: false, reason: "computeRefund not exported" };
      if (!/refunds/.test(read(dir, "src/index.js"))) return { ok: false, reason: "not wired into index.js" };
      return assertScript(dir, "import { computeRefund } from './src/index.js'; if(typeof computeRefund!=='function') throw new Error('not exported from index');");
    },
  },
  {
    id: "search-imports-lg",
    modules: 40,
    maxTurns: 40,
    optimizes: "micro: Search at scale",
    prompt:
      "In this repo, list every file path that imports the logger module, one path per line. Do not edit any files.",
    expectMentions: ["src/mod/mod000.js", "src/mod/mod020.js", "src/mod/mod039.js", "src/index.js"],
  },
];

// Default benchmark set = the realistic multi-step tasks.
export const DEFAULT_TASK_IDS = ["feat-currency", "bugfix-clamp", "add-service", "add-tests"];
