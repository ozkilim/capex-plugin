import fs from "node:fs";
import path from "node:path";
import { capexDir, sessionFile, lifetimeFile, freshState } from "../src/paths.js";

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function getSessionId() {
  const argIdx = process.argv.indexOf("--session");
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return null;
}

function countSessions() {
  try {
    return fs.readdirSync(capexDir()).filter((f) => /^session-.*\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return n.toLocaleString("en-US");
  return String(Math.round(n));
}

function byToolLine(byTool) {
  const b = byTool || {};
  return `Search=${b.Search ?? 0}, Edit=${b.Edit ?? 0}, Read=${b.Read ?? 0}, Write=${b.Write ?? 0}`;
}

const lines = [];
lines.push("CAPEX savings report");
lines.push("====================");

const sessionId = getSessionId();
if (sessionId) {
  const s = load(sessionFile(sessionId)) || freshState();
  lines.push("");
  lines.push("This session:");
  lines.push(`  Estimated saved: $${(s.usdSaved ?? 0).toFixed(2)} (${fmtTokens(s.tokensSaved ?? 0)} tokens, ${((s.msSaved ?? 0) / 1000).toFixed(1)}s)`);
  lines.push(`  Roundtrips collapsed: ${s.roundtripsSaved ?? 0}`);
  lines.push(`  Tool calls: ${byToolLine(s.byTool)}`);
}

const lt = load(lifetimeFile()) || freshState();
lines.push("");
lines.push("Lifetime:");
lines.push(`  Estimated saved: $${(lt.usdSaved ?? 0).toFixed(2)} (${fmtTokens(lt.tokensSaved ?? 0)} tokens, ${((lt.msSaved ?? 0) / 1000).toFixed(1)}s)`);
lines.push(`  Roundtrips collapsed: ${lt.roundtripsSaved ?? 0}`);
lines.push(`  Sessions: ${countSessions()}`);

lines.push("");
lines.push("Note: figures are heuristic estimates based on per-call constants in");
lines.push("src/savings-model.js. Tune them to your usage.");

process.stdout.write(lines.join("\n") + "\n");
