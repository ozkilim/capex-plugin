#!/usr/bin/env node
// CAPEX A/B benchmark.
//
// For each task, run it twice on an identical fresh copy of the fixture repo:
//   - vanilla : stock Claude Code tools (CAPEX MCP tools denied)
//   - capex   : the capex:code agent with optimized Search/Edit/Read
// then compare Anthropic's OWN reported cost + token usage. Optionally repeat
// each arm N trials and report the mean (cache warmth adds run-to-run noise).
//
// Usage:
//   node bench/run.js [--trials N] [--model sonnet] [--tasks id,id] [--keep]
//
// Requires: `claude` CLI on PATH and an authenticated config (same machine you
// use Claude Code on). This spends real API budget — a few cents per arm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tasks as ALL_TASKS, DEFAULT_TASK_IDS } from "./tasks.js";
import { runArm } from "./lib/measure.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "..");
const MAKE_FIXTURE = path.join(__dirname, "make-fixture.js");

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const TRIALS = Number(arg("--trials", "1"));
const MODEL = arg("--model", "sonnet");
const MODE = process.argv.includes("--isolated") ? "isolated" : "product";
const KEEP = process.argv.includes("--keep");
const ONLY = (arg("--tasks", "") || "").split(",").filter(Boolean);
const TASKS = ONLY.length
  ? ALL_TASKS.filter((t) => ONLY.includes(t.id))
  : ALL_TASKS.filter((t) => DEFAULT_TASK_IDS.includes(t.id));

function freshFixture(modules = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-bench-"));
  const args = [MAKE_FIXTURE, dir];
  if (modules) args.push("--modules", String(modules));
  const r = spawnSync("node", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error("fixture gen failed: " + r.stderr);
  return dir;
}

function mean(xs) {
  const v = xs.filter((x) => typeof x === "number" && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
const usd = (n) => "$" + (n ?? 0).toFixed(4);
const k = (n) => (n / 1000).toFixed(1) + "k";
const pct = (base, val) => (base > 0 ? (((base - val) / base) * 100).toFixed(1) + "%" : "—");

function checkOutcome(task, dir, out) {
  if (task.verify) return task.verify(dir);
  if (task.expectMentions) {
    const txt = (out.result || "").toLowerCase();
    const missing = task.expectMentions.filter((m) => !txt.includes(m.toLowerCase()));
    return missing.length
      ? { ok: false, reason: "missing " + missing.length + "/" + task.expectMentions.length }
      : { ok: true };
  }
  return { ok: true };
}

async function main() {
  console.log(`CAPEX A/B benchmark — mode=${MODE} model=${MODEL} trials=${TRIALS} tasks=${TASKS.length}\n`);
  const rows = [];

  for (const task of TASKS) {
    process.stdout.write(`▶ ${task.id}  (${task.optimizes})\n`);
    const arms = { vanilla: [], capex: [] };

    for (let t = 0; t < TRIALS; t++) {
      // Alternate which arm runs first each trial to cancel server-side
      // prompt-cache warmth (the 2nd arm within ~5min rides a warmer cache).
      const order = t % 2 === 0 ? ["vanilla", "capex"] : ["capex", "vanilla"];
      for (const arm of order) {
        const dir = freshFixture(task.modules || 0);
        const out = runArm({ arm, prompt: task.prompt, cwd: dir, model: MODEL, pluginDir: PLUGIN_DIR, maxTurns: task.maxTurns || 30, mode: MODE });
        out.outcome = out.ok ? checkOutcome(task, dir, out) : { ok: false, reason: out.error };
        arms[arm].push(out);
        process.stdout.write(
          `   ${arm.padEnd(7)} t${t + 1}: ${out.ok ? usd(out.costUsd) : "ERR"} ` +
          `${out.tokens ? k(out.tokens.fresh) + " fresh" : ""} ` +
          `${out.numTurns ?? "?"} turns ${out.durationMs ? (out.durationMs / 1000).toFixed(0) + "s " : ""}` +
          `${out.outcome.ok ? "✓" : "✗ " + out.outcome.reason}\n`
        );
        if (KEEP) out._dir = dir; else fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    const vCost = mean(arms.vanilla.map((a) => a.costUsd));
    const cCost = mean(arms.capex.map((a) => a.costUsd));
    const vTok = mean(arms.vanilla.map((a) => a.tokens?.fresh));
    const cTok = mean(arms.capex.map((a) => a.tokens?.fresh));
    const vTurns = mean(arms.vanilla.map((a) => a.numTurns));
    const cTurns = mean(arms.capex.map((a) => a.numTurns));
    const vTime = mean(arms.vanilla.map((a) => a.durationMs));
    const cTime = mean(arms.capex.map((a) => a.durationMs));
    rows.push({ task, vCost, cCost, vTok, cTok, vTurns, cTurns, vTime, cTime, arms });
  }

  // Markdown summary table.
  console.log("\n## Results (mean over " + TRIALS + " trial" + (TRIALS > 1 ? "s" : "") + ")\n");
  console.log("| Task | Cost vanilla | Cost capex | Cost saved | Fresh tok v/c | Fresh saved | Turns v/c | Time v/c (s) | Time saved |");
  console.log("|------|------|------|------|------|------|------|------|------|");
  let tv = 0, tc = 0, ttv = 0, ttc = 0, tvt = 0, tct = 0;
  for (const r of rows) {
    tv += r.vCost; tc += r.cCost; ttv += r.vTok; ttc += r.cTok; tvt += r.vTime; tct += r.cTime;
    console.log(
      `| ${r.task.id} | ${usd(r.vCost)} | ${usd(r.cCost)} | ${pct(r.vCost, r.cCost)} | ` +
      `${k(r.vTok)}/${k(r.cTok)} | ${pct(r.vTok, r.cTok)} | ${r.vTurns.toFixed(0)}/${r.cTurns.toFixed(0)} | ` +
      `${(r.vTime / 1000).toFixed(0)}/${(r.cTime / 1000).toFixed(0)} | ${pct(r.vTime, r.cTime)} |`
    );
  }
  console.log(
    `| **TOTAL** | **${usd(tv)}** | **${usd(tc)}** | **${pct(tv, tc)}** | ` +
    `**${k(ttv)}/${k(ttc)}** | **${pct(ttv, ttc)}** | | ` +
    `**${(tvt / 1000).toFixed(0)}/${(tct / 1000).toFixed(0)}** | **${pct(tvt, tct)}** |`
  );

  const outPath = path.join(__dirname, "results.json");
  fs.writeFileSync(outPath, JSON.stringify({ mode: MODE, model: MODEL, trials: TRIALS, when: new Date().toISOString(), rows: rows.map(stripDirs) }, null, 2));
  console.log("\nRaw results -> " + outPath);
}

function stripDirs(r) {
  const clean = (a) => a.map(({ _dir, ...rest }) => rest);
  return { id: r.task.id, optimizes: r.task.optimizes, vCost: r.vCost, cCost: r.cCost, vTok: r.vTok, cTok: r.cTok, vTime: r.vTime, cTime: r.cTime, arms: { vanilla: clean(r.arms.vanilla), capex: clean(r.arms.capex) } };
}

main().catch((e) => { console.error(e); process.exit(1); });
