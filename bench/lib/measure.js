// Run a single benchmark arm (one task, one toolset) as a headless one-shot
// `claude -p` invocation and parse Anthropic's own reported cost + token usage.
//
// We treat `total_cost_usd` and `usage` from the JSON result as ground truth —
// these are the numbers Anthropic bills, not our estimates. That is the whole
// point of the benchmark: prove savings with real billing data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sumTranscriptDir, costOf, freshTokens } from "../../src/transcript.js";

// Locate the PROJECT DIR that holds a session's transcript (and any sub-agent
// transcripts spawned during the run, which Claude Code files in the same dir).
function findProjectDir(sessionId) {
  if (!sessionId) return null;
  const base = path.join(os.homedir(), ".claude", "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return null; }
  for (const d of dirs) {
    if (fs.existsSync(path.join(base, d, sessionId + ".jsonl"))) return path.join(base, d);
  }
  return null;
}

function countJsonl(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length; }
  catch { return 0; }
}

// CAPEX MCP tools — denied on the vanilla arm so it must fall back to the
// built-in Read/Grep/Glob/Edit tools, i.e. a true "stock Claude Code" baseline.
const CAPEX_TOOLS = [
  "mcp__plugin_capex_code__Search",
  "mcp__plugin_capex_code__Read",
  "mcp__plugin_capex_code__Edit",
  "mcp__plugin_capex_code__Write",
  "mcp__plugin_capex_code__Outline",
  "mcp__plugin_capex_code__Refs",
  "mcp__plugin_capex_code__Def",
  "mcp__plugin_capex_code__Sql",
  "mcp__plugin_capex_code__Replace",
  "mcp__plugin_capex_code__RunTests",
  "mcp__plugin_capex_code__View",
  "mcp__plugin_capex_code__Map",
  "mcp__plugin_capex_code__Imports",
  "mcp__plugin_capex_code__Insert",
  "mcp__plugin_capex_code__Where",
  "mcp__plugin_capex_code__Run",
];
const BUILTIN_FILE_TOOLS = ["Read", "Edit", "MultiEdit", "Write", "Grep", "Glob", "NotebookEdit"];
// Escape hatches / noise denied on BOTH arms in isolated mode so the only
// variable is the file-toolset: no sed via Bash, no subagent fan-out.
const ESCAPE_HATCHES = ["Bash", "Task", "Agent", "BashOutput", "KillShell"];

// A deliberately neutral agent used on BOTH arms in isolated mode. It carries
// NO instruction to prefer any particular tool, so we measure the tools, not
// an agent prompt. (Tool-specific guidance lives in each tool's own schema.)
const NEUTRAL_AGENT = {
  bench: {
    description: "Neutral benchmark agent. Completes the task with available tools.",
    prompt:
      "You are a coding agent. Complete the user's task correctly and efficiently " +
      "using the tools available to you. Do not ask follow-up questions.",
  },
};

/**
 * @param {object} opts
 * @param {"vanilla"|"capex"} opts.arm
 * @param {string} opts.prompt
 * @param {string} opts.cwd        working dir (a fresh fixture copy)
 * @param {string} opts.model      e.g. "sonnet"
 * @param {number} opts.maxTurns
 * @param {string} opts.pluginDir  absolute path to capex-plugin (for capex arm)
 * @param {"product"|"isolated"} opts.mode
 *   product  = shipped reality: capex:code agent vs stock default agent.
 *   isolated = apples-to-apples: same neutral agent both arms, Bash + subagents
 *              denied on both, only the file-toolset swapped.
 */
export function runArm(opts) {
  const { arm, prompt, cwd, model = "sonnet", maxTurns = 30, pluginDir, mode = "product" } = opts;

  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--dangerously-skip-permissions",
  ];

  if (mode === "isolated") {
    // Same agent + same denied escape hatches on both arms; swap only the files
    // tools. The plugin must be loaded on both so MCP tools exist to allow/deny.
    if (pluginDir) args.push("--plugin-dir", pluginDir);
    args.push("--agents", JSON.stringify(NEUTRAL_AGENT), "--agent", "bench");
    const deny = [...ESCAPE_HATCHES];
    if (arm === "capex") deny.push(...BUILTIN_FILE_TOOLS);
    else deny.push(...CAPEX_TOOLS);
    args.push("--disallowedTools", ...deny);
  } else if (arm === "capex") {
    // Use the plugin's optimized agent. --plugin-dir makes the run independent
    // of whatever is globally installed, so the benchmark is self-contained.
    if (pluginDir) args.push("--plugin-dir", pluginDir);
    args.push("--agent", "capex:code");
  } else {
    // Vanilla: deny the CAPEX MCP tools so the model uses built-in file tools.
    args.push("--disallowedTools", ...CAPEX_TOOLS);
  }

  const started = Date.now();
  const res = spawnSync("claude", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const wallMs = Date.now() - started;

  if (res.error) {
    return { arm, ok: false, error: String(res.error), wallMs };
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return {
      arm, ok: false,
      error: "could not parse JSON result: " + e.message,
      stdoutHead: (res.stdout || "").slice(0, 500),
      stderrHead: (res.stderr || "").slice(0, 500),
      wallMs,
    };
  }

  // CUMULATIVE usage across the run's whole project dir (main session + any
  // sub-agent transcripts). parsed.usage is final-turn only, so we sum the
  // transcripts; total_cost_usd is kept as an authoritative cross-check.
  const projectDir = findProjectDir(parsed.session_id);
  const cum = projectDir ? sumTranscriptDir(projectDir) : null;

  return {
    arm,
    ok: parsed.is_error !== true,
    sessionId: parsed.session_id,
    projectDir,
    // # of extra transcripts beyond the main session = sub-agents spawned.
    subAgents: projectDir ? Math.max(0, countJsonl(projectDir) - 1) : 0,
    // CLI's own cumulative cost — kept for reference, but it carries opaque
    // cache-pricing/retry effects, so we report our transparent costUsd below.
    cliCostUsd: parsed.total_cost_usd ?? null,
    // Transparent cost from cumulative tokens under src/transcript.js PRICING.
    costUsd: cum ? costOf(cum) : (parsed.total_cost_usd ?? null),
    numTurns: parsed.num_turns ?? null,
    durationMs: parsed.duration_ms ?? wallMs,
    wallMs,
    tokens: cum
      ? {
          input: cum.input,
          cacheCreate: cum.cacheCreate,
          cacheRead: cum.cacheRead,
          output: cum.output,
          total: cum.input + cum.cacheCreate + cum.cacheRead + cum.output,
          // "Fresh" = non-cache-read work: the cache-warmth-independent signal.
          fresh: freshTokens(cum),
        }
      : null,
    result: parsed.result || "",
  };
}
