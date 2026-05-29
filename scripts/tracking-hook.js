import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { ensureCapexDir, sessionFile, lifetimeFile, freshState } from "../src/paths.js";
import { estimateSavings } from "../src/savings-model.js";
import { sumTranscript, perRoundtrip } from "../src/transcript.js";
import { authFile } from "../src/remote.js";

// If the machine is linked to a CAPEX account, push the updated lifetime
// totals in a detached process so the hook returns immediately.
function maybeSync() {
  try {
    if (!fs.existsSync(authFile())) return;
    const here = path.dirname(fileURLToPath(import.meta.url));
    const child = spawn(process.execPath, [path.join(here, "sync.js")], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // never block tool flow on sync
  }
}

const CAPEX_TOOL_PREFIX = "mcp__plugin_capex_code__";

// A statusLine command is "ours" if it shells out to CAPEX's status-line.js.
// We detect by substring so we recognize our own line even when the install
// path has changed (e.g. after a version bump or reinstall).
function isCapexStatusLine(cmd) {
  return typeof cmd === "string" && cmd.includes("status-line.js") && cmd.includes("capex");
}

// Self-install the CAPEX status line into the user's ~/.claude/settings.json on
// session start, so the bottom-line savings indicator appears with zero manual
// setup and survives reinstalls/version bumps. Idempotent and respectful:
//   - if there is no statusLine, we add ours;
//   - if the existing statusLine is already ours (possibly a stale path), we
//     refresh it to THIS install's path;
//   - if the user has their own non-CAPEX statusLine, we leave it untouched;
//   - we only write when something actually changes.
// Never throws into the hook flow.
function ensureStatusLine() {
  try {
    // Absolute path to the status-line.js shipped alongside this hook. Using the
    // live path means a version bump (new CLAUDE_PLUGIN_ROOT) self-corrects.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const statusLinePath = path.join(here, "status-line.js");
    const desiredCommand = `node ${statusLinePath}`;

    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");

    let settings = {};
    if (fs.existsSync(settingsPath)) {
      // If settings.json is present but unparseable, do NOT touch it — we must
      // never risk clobbering a user's hand-edited config.
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch {
        return;
      }
    }
    if (settings == null || typeof settings !== "object") return;

    const existing = settings.statusLine;
    const existingCmd = existing && existing.command;

    // Respect a user's own status line.
    if (existing && !isCapexStatusLine(existingCmd)) return;

    // Already correct → nothing to do (keeps us from rewriting every session).
    if (existing && existingCmd === desiredCommand) return;

    settings.statusLine = { type: "command", command: desiredCommand };

    const tmp = settingsPath + ".capex.tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, settingsPath);
  } catch {
    // never block session start on status-line setup
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function loadState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return freshState();
  }
}

function atomicWrite(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function withLockedUpdate(file, mutate) {
  if (!fs.existsSync(file)) {
    try { atomicWrite(file, freshState()); } catch {}
  }
  let release;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      release = lockfile.lockSync(file, { stale: 5000, retries: 0 });
      break;
    } catch {
      // brief spin; locks are held only for a few ms
    }
  }
  try {
    const state = loadState(file);
    mutate(state);
    atomicWrite(file, state);
  } finally {
    if (release) {
      try { release(); } catch {}
    }
  }
}

function toolShortName(toolName) {
  if (!toolName) return null;
  const idx = toolName.lastIndexOf("__");
  return idx === -1 ? toolName : toolName.slice(idx + 2);
}

// Pull any text out of the various tool_response shapes Claude Code may pass.
function extractText(tr) {
  if (!tr) return "";
  if (typeof tr === "string") return tr;
  if (Array.isArray(tr)) return tr.map((x) => (x && x.text) || "").join("\n");
  if (Array.isArray(tr.content)) return tr.content.map((x) => (x && x.text) || "").join("\n");
  return "";
}

// Claude Code does not pass the MCP result's _meta inside tool_response to the
// hook (it surfaces separately as mcpMeta), so reconstruct the savings meta
// from tool_name + tool_input, which are always present. Fall back to any
// _meta.capex if a future version does pass it.
function deriveMeta(event) {
  const direct = event?.tool_response?._meta?.capex || event?.mcpMeta?._meta?.capex;
  if (direct) return direct;

  const short = toolShortName(event.tool_name);
  const input = event.tool_input || {};
  switch (short) {
    case "Search": {
      const text = extractText(event.tool_response);
      const matches = text ? (text.match(/^>\s/gm) || []).length : 0;
      return { mode: "search", matches, filesScanned: 0 };
    }
    case "Edit":
      return { mode: "edit", batchSize: Array.isArray(input.edits) ? input.edits.length : 1 };
    case "Read": {
      let totalLines = 0;
      const sig = !!input.signatures_only;
      if (sig && input.file) {
        try { totalLines = fs.readFileSync(input.file, "utf8").split("\n").length; } catch {}
      }
      return { mode: "read", signaturesOnly: sig, truncated: false, totalLines };
    }
    case "Refs":
    case "Def": {
      const text = extractText(event.tool_response);
      const files = text ? (text.match(/^[^\s(].*[./].*$/gm) || []).length : 0;
      return { mode: short === "Refs" ? "refs" : "def", files };
    }
    case "Sql":
      return { mode: "sql", ran: true };
    case "Replace": {
      const text = extractText(event.tool_response);
      const fm = text.match(/across (\d+) file/);
      const om = text.match(/Replaced (\d+) occurrence/);
      return { mode: "replace", files: fm ? Number(fm[1]) : 0, occurrences: om ? Number(om[1]) : 0 };
    }
    case "RunTests":
      return { mode: "runtests" };
    case "Map": {
      const text = extractText(event.tool_response);
      const sourceFiles = (text.match(/\s::\s/g) || []).length;
      return { mode: "map", files: text ? text.split("\n").length : 0, sourceFiles };
    }
    case "Imports": {
      const text = extractText(event.tool_response);
      const edges = text ? (text.match(/^[^\s].*:\d+:/gm) || []).length : 0;
      return { mode: "imports", files: edges, edges };
    }
    case "Insert": {
      const text = extractText(event.tool_response);
      return { mode: "insert", inserted: /Inserted \d+ line/.test(text) };
    }
    case "Where": {
      const text = extractText(event.tool_response);
      const fm = text.match(/across (\d+) file/);
      return { mode: "where", files: fm ? Number(fm[1]) : 0 };
    }
    case "Run":
      return { mode: "run" };
    case "View": {
      const text = extractText(event.tool_response);
      const rm = text.match(/:(\d+)-(\d+)/);
      const linesReturned = rm ? Number(rm[2]) - Number(rm[1]) + 1 : 0;
      return { mode: "view", found: rm ? 1 : 0, linesReturned, totalLines: 0 };
    }
    case "Outline": {
      // Reconstruct from result text: count file-header lines (a path line is
      // not indented and contains a path/extension). linesElided is unknown
      // from text, so approximate per covered file.
      const text = extractText(event.tool_response);
      const files = text ? (text.match(/^[^\s(].*[./].*$/gm) || []).length : 0;
      return { mode: "outline", files, linesElided: files * 40 };
    }
    case "Write":
      return { mode: "write" };
    default:
      return null;
  }
}

function main() {
  ensureCapexDir();
  const raw = readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch { event = {}; }

  const sessionId = event.session_id || "unknown";
  const sFile = sessionFile(sessionId);

  if (event.hook_event_name === "SessionStart") {
    if (!fs.existsSync(sFile)) {
      try { atomicWrite(sFile, freshState()); } catch {}
    }
    ensureStatusLine();
    return;
  }

  // PostToolUse: only track CAPEX MCP tools (matcher is catch-all, filter here).
  if (!event.tool_name || !event.tool_name.includes(CAPEX_TOOL_PREFIX)) return;

  const meta = deriveMeta(event);
  if (!meta) return;

  // Price avoided roundtrips at THIS session's real average per-turn context
  // cost (read from the live transcript), not a fixed constant. Falls back to
  // the model's conservative default if the transcript isn't readable yet.
  let ctx = {};
  if (event.transcript_path) {
    try {
      const cum = sumTranscript(event.transcript_path);
      if (cum.turns > 0) {
        const rt = perRoundtrip(cum);
        ctx = { perRoundtripTokens: rt.tokens, perRoundtripUsd: rt.usd };
      }
    } catch { /* fall back to defaults */ }
  }

  const saved = estimateSavings(meta, ctx);
  const short = toolShortName(event.tool_name);

  const apply = (state) => {
    state.tokensSaved += saved.tokensSaved;
    state.roundtripsSaved += saved.roundtripsSaved;
    state.msSaved += saved.msSaved;
    state.usdSaved += saved.usdSaved;
    state.toolCalls += 1;
    if (short && Object.prototype.hasOwnProperty.call(state.byTool, short)) {
      state.byTool[short] += 1;
    }
  };

  withLockedUpdate(sFile, apply);
  withLockedUpdate(lifetimeFile(), apply);
  maybeSync();
}

try {
  main();
} catch {
  // never block tool flow
}
process.exit(0);
