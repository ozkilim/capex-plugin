import fs from "node:fs";
import { sessionFile } from "../src/paths.js";

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

try {
  let ctx = {};
  try { ctx = JSON.parse(readStdin()); } catch { ctx = {}; }
  const sessionId = ctx.session_id;
  if (!sessionId) {
    process.stdout.write("💰 CAPEX: tracking…");
    process.exit(0);
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(sessionFile(sessionId), "utf8"));
  } catch {
    process.stdout.write("💰 CAPEX: tracking…");
    process.exit(0);
  }
  if (!state || (state.toolCalls ?? 0) === 0) {
    process.stdout.write("💰 CAPEX: tracking…");
    process.exit(0);
  }
  const usd = (state.usdSaved ?? 0).toFixed(2);
  const tokens = fmtTokens(state.tokensSaved ?? 0);
  const secs = ((state.msSaved ?? 0) / 1000).toFixed(1);
  const rt = state.roundtripsSaved ?? 0;
  process.stdout.write(`💰 CAPEX est. session savings: $${usd} · ${tokens} tokens · ${secs}s · ${rt} roundtrips`);
} catch {
  process.stdout.write("");
}
process.exit(0);
