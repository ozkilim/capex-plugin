#!/usr/bin/env node
// Deterministic, FREE output-size measurement for the Round-2 tricks. No API
// spend: it just calls each tool on a generated fixture and counts output
// characters (tokens ~= chars/4). This proves the OUTPUT-token lever directly,
// independent of the cache-noisy end-to-end $ benchmark.
//
//   node bench/measure-output.js [--modules 24]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import { doReplace } from "../src/replace.js";
import { doSearch } from "../src/search.js";
import { doOutline } from "../src/outline.js";
import { doView } from "../src/view.js";
import { doRead } from "../src/read.js";
import { doMap } from "../src/map.js";
import { doRun } from "../src/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mi = process.argv.indexOf("--modules");
const MODULES = mi >= 0 ? Number(process.argv[mi + 1]) || 24 : 24;
const tok = (s) => Math.ceil((s || "").length / 4);
const pct = (a, b) => (((a - b) / a) * 100).toFixed(0) + "%";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-measure-"));
spawnSync("node", [path.join(__dirname, "make-fixture.js"), dir, "--modules", String(MODULES)], { encoding: "utf8" });

const rows = [];

// 1. Rename: batched-Edit echo vs Replace summary.
const files = await glob(["**/*.js"], { cwd: dir, ignore: ["**/node_modules/**"] });
let occ = 0;
const fakeEdits = [];
for (const f of files) {
  const t = fs.readFileSync(path.join(dir, f), "utf8");
  const m = t.match(/\bcomputeTotal\b/g);
  if (m) { occ += m.length; fakeEdits.push({ file: f, old_string: "computeTotal", new_string: "calcTotal", replace_all: true }); }
}
const editEcho = tok(JSON.stringify({ edits: fakeEdits }));
const rep = await doReplace({ old_string: "computeTotal", new_string: "calcTotal", word_boundary: true, cwd: dir });
rows.push([`Rename computeTotal (${occ} occ, ${rep.meta.files} files)`, "batched-Edit echo", editEcho, "Replace summary", tok(rep.text)]);

// 2. Search terse vs verbose.
const terse = await doSearch({ file_glob_patterns: ["**/*.js"], content_regex: "logger", cwd: dir, max_results: 200 });
const verbose = await doSearch({ file_glob_patterns: ["**/*.js"], content_regex: "logger", cwd: dir, max_results: 200, context_lines: 2 });
rows.push([`Search "logger" (${terse.meta.matches} hits)`, "verbose ctx=2", tok(verbose.text), "terse default", tok(terse.text)]);

// 3. Outline sig vs names.
const osig = await doOutline({ file_glob_patterns: ["src/**/*.js"], cwd: dir, detail: "sig" });
const onames = await doOutline({ file_glob_patterns: ["src/**/*.js"], cwd: dir, detail: "names" });
rows.push([`Outline src (${osig.meta.files} files, ${osig.meta.symbols} syms)`, "detail=sig", tok(osig.text), "detail=names", tok(onames.text)]);

// 4. Full Read vs View one symbol. (Do BEFORE any rename of computeTotal in this dir — it's a fresh fixture so fine.)
const full = await doRead({ file: path.join(dir, "src/util/money.js") });
const v = await doView({ file: "src/util/money.js", symbol: "formatUSD", cwd: dir });
rows.push([`Read one symbol (formatUSD)`, "full Read", tok(full.text), "View", tok(v.text)]);

// 5. Cold-start: read every source file vs one Map call.
const srcs = await glob(["src/**/*.js"], { cwd: dir });
let fullAll = 0;
for (const f of srcs) { const rr = await doRead({ file: path.join(dir, f) }); fullAll += tok(rr.text); }
const m = await doMap({ cwd: dir });
rows.push([`Cold-start orient (${srcs.length} source files)`, "read all files", fullAll, "Map (1 call)", tok(m.text)]);

// 6. code_only vs full read on a doc-padded module.
const mod = path.join(dir, "src/services/orders.js");
const fullMod = await doRead({ file: mod });
const codeOnly = await doRead({ file: mod, code_only: true });
rows.push([`Read doc-padded module`, "full", tok(fullMod.text), "code_only", tok(codeOnly.text)]);

// 7. Run: a passing 150-line command's output suppressed.
const run = await doRun({ command: 'node -e "for(let i=0;i<150;i++)console.log(i)"', cwd: dir });
rows.push([`Run passing 150-line command`, "Bash dumps ~150 lines", 150 * 2, "Run summary", tok(run.text)]);

console.log(`\nOutput-size comparison on ${MODULES}-module fixture (tokens ~= chars/4):\n`);
for (const [label, oldName, oldTok, newName, newTok] of rows) {
  console.log(`  ${label}`);
  console.log(`     ${oldName}: ${oldTok} tok   ->   ${newName}: ${newTok} tok   (${pct(oldTok, newTok)} less output)`);
}
console.log("");

fs.rmSync(dir, { recursive: true, force: true });
