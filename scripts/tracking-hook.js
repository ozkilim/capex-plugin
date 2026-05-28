import fs from "node:fs";
import lockfile from "proper-lockfile";
import { ensureCapexDir, sessionFile, lifetimeFile, freshState } from "../src/paths.js";
import { estimateSavings } from "../src/savings-model.js";

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

// Update a state file under an exclusive lock to survive parallel hook fires.
function withLockedUpdate(file, mutate) {
  // Ensure the file exists so lockfile has a target.
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

  // PostToolUse
  const meta = event?.tool_response?._meta?.capex;
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
}

try {
  main();
} catch {
  // never block tool flow
}
process.exit(0);
