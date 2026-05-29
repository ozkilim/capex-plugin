import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function capexDir() {
  return path.join(os.homedir(), ".capex");
}

export function ensureCapexDir() {
  const dir = capexDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionFile(sessionId) {
  return path.join(capexDir(), `session-${sessionId}.json`);
}

export function lifetimeFile() {
  return path.join(capexDir(), "lifetime.json");
}

export function freshState() {
  return {
    version: 1,
    startedAt: Date.now(),
    tokensSaved: 0,
    roundtripsSaved: 0,
    msSaved: 0,
    usdSaved: 0,
    toolCalls: 0,
    byTool: { Search: 0, Edit: 0, Read: 0, Write: 0, Outline: 0, Refs: 0, Def: 0, Sql: 0, Replace: 0, RunTests: 0, View: 0, Map: 0, Imports: 0, Insert: 0, Where: 0, Run: 0 }
  };
}
