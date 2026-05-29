#!/usr/bin/env node
// CLI: scan your real Claude Code transcripts for inefficiency patterns CAPEX
// would have collapsed, and report estimated roundtrips / tokens / $ saved.
//
//   node scripts/savings-scan.js [--days N]
//
// Measures waste that ACTUALLY happened in your sessions (vanilla or CAPEX).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanTranscript, aggregate } from "../src/scan.js";

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const days = Number(arg("--days", "0"));
const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0;

const base = path.join(os.homedir(), ".claude", "projects");
let files = [];
try {
  for (const d of fs.readdirSync(base)) {
    const dir = path.join(base, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      if (cutoff && fs.statSync(p).mtimeMs < cutoff) continue;
      files.push(p);
    }
  }
} catch {
  console.error("No ~/.claude/projects found.");
  process.exit(0);
}

const results = files.map(scanTranscript);
const t = aggregate(results);

const usd = (n) => "$" + n.toFixed(2);
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
console.log(`\nCAPEX retroactive savings scan — ${t.sessions} session(s)${days ? `, last ${days}d` : ""}\n`);
if (!t.callsSaved) {
  console.log("No collapsible inefficiency patterns detected. (Already efficient, or CAPEX sessions.)");
} else {
  console.log("Inefficiency patterns CAPEX would have collapsed:");
  const labels = { grep_read: "grep/glob → read (Search)", read_batch: "read batches (Search/Read)", edit_batch: "edit batches (batched Edit)", failed_edit: "failed-edit retry loops (robust Edit)", bash_sql: "repeated sqlite/psql (Sql)" };
  for (const [type, n] of Object.entries(t.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${labels[type] || type}`);
  }
  console.log(`\nEstimated savings (had CAPEX been used):`);
  console.log(`  ~${t.callsSaved} tool-call roundtrips`);
  console.log(`  ~${k(t.tokensSaved)} tokens reprocessed (mostly cheap cache reads)`);
  console.log(`  ~${usd(t.usdSaved)} (at the sessions' real per-turn cost)`);
}
console.log("");
