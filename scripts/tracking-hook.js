import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { ensureCapexDir, sessionFile, lifetimeFile, freshState } from "../src/paths.js";
import { estimateSavings } from "../src/savings-model.js";
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
    return;
  }

  // PostToolUse: only track CAPEX MCP tools (matcher is catch-all, filter here).
  if (!event.tool_name || !event.tool_name.includes(CAPEX_TOOL_PREFIX)) return;

  const meta = deriveMeta(event);
  if (!meta) return;

  const saved = estimateSavings(meta);
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
