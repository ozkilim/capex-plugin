// Transcript-grounded measurement utilities, shared by the live savings model
// (scripts/tracking-hook.js) and the offline A/B benchmark (bench/).
//
// Claude Code writes a JSONL transcript per session. Each assistant message
// carries a `usage` block with Anthropic's REAL token counts. Summing these
// gives cumulative session usage — the ground truth for "what did this cost".
//
// IMPORTANT: the `usage` returned by `claude -p --output-format json` is the
// FINAL turn only, not cumulative. Always sum the transcript for session totals.
import fs from "node:fs";
import path from "node:path";

// Anthropic Sonnet pricing (USD per million tokens). Transparent + tunable.
// cacheWrite ~= 1.25x input (5-minute ephemeral); cacheRead ~= 0.1x input.
export const PRICING = {
  inputPerMtok: 3.0,
  outputPerMtok: 15.0,
  cacheWritePerMtok: 3.75,
  cacheReadPerMtok: 0.30,
};

export function emptyUsage() {
  return { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, turns: 0, toolUses: 0 };
}

/** Sum cumulative usage across every assistant turn in a transcript JSONL. */
export function sumTranscript(transcriptPath) {
  const u = emptyUsage();
  let text;
  try { text = fs.readFileSync(transcriptPath, "utf8"); } catch { return u; }
  // Claude Code can log the same assistant message multiple times (streaming
  // partials, retries with the same requestId). Dedupe by the API message id /
  // requestId so a turn's usage is counted ONCE — otherwise tokens inflate 2-3x.
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant") continue;
    const usage = (d.message && d.message.usage) || d.usage;
    if (!usage) continue;
    const id = (d.message && d.message.id) || d.requestId || d.uuid;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    u.input += usage.input_tokens || 0;
    u.cacheCreate += usage.cache_creation_input_tokens || 0;
    u.cacheRead += usage.cache_read_input_tokens || 0;
    u.output += usage.output_tokens || 0;
    u.turns += 1;
    if (Array.isArray(d.message?.content))
      u.toolUses += d.message.content.filter((c) => c && c.type === "tool_use").length;
  }
  return u;
}

/**
 * Sum cumulative usage across EVERY transcript in a project dir. Claude Code
 * files a run's main session AND any spawned sub-agent sessions under the dir
 * keyed to the run's cwd; summing them all captures sub-agent tokens that a
 * single-file sum would miss. Safe when the cwd is unique per run (as in bench).
 */
export function sumTranscriptDir(dir) {
  const total = emptyUsage();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return total; }
  for (const f of files) {
    const u = sumTranscript(path.join(dir, f));
    total.input += u.input; total.cacheCreate += u.cacheCreate;
    total.cacheRead += u.cacheRead; total.output += u.output;
    total.turns += u.turns; total.toolUses += u.toolUses;
  }
  return total;
}

/** USD cost of a usage object under PRICING. */
export function costOf(u) {
  return (
    (u.input * PRICING.inputPerMtok +
      u.cacheCreate * PRICING.cacheWritePerMtok +
      u.cacheRead * PRICING.cacheReadPerMtok +
      u.output * PRICING.outputPerMtok) /
    1_000_000
  );
}

/** "Fresh" (non-cache-read) tokens — the cache-warmth-independent work signal. */
export function freshTokens(u) {
  return u.input + u.cacheCreate + u.output;
}

/**
 * Marginal cost of ONE avoided tool-call roundtrip in this session.
 *
 * Each extra roundtrip re-sends the whole conversation to the model. The bulk
 * is cache reads (cheap) plus a little fresh input + the output the model emits
 * to issue/!consume the call. We approximate the marginal roundtrip as the
 * average per-turn billed cost — this is what CAPEX actually saves by avoiding
 * a turn, and it is grounded in THIS session's real context size.
 */
export function perRoundtrip(u) {
  const turns = Math.max(1, u.turns);
  const avg = {
    input: u.input / turns,
    cacheCreate: u.cacheCreate / turns,
    cacheRead: u.cacheRead / turns,
    output: u.output / turns,
  };
  return {
    tokens: avg.input + avg.cacheCreate + avg.cacheRead + avg.output,
    usd: costOf(avg),
  };
}
