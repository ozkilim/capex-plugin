import { test, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(__dirname, "..", "scripts", "tracking-hook.js");

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "capex-home-"));
});

function fireHook(event) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HOOK], { env: { ...process.env, HOME: home }, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

function searchEvent(sessionId) {
  return {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "mcp__plugin_capex_code__Search",
    tool_input: {},
    tool_response: { _meta: { capex: { mode: "search", filesScanned: 10, matches: 2 } } }
  };
}

function readState(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("single Search event writes session file with updated counters", async () => {
  await fireHook(searchEvent("s1"));
  const s = readState(path.join(home, ".capex", "session-s1.json"));
  assert.strictEqual(s.toolCalls, 1);
  assert.strictEqual(s.byTool.Search, 1);
  assert.ok(s.tokensSaved > 0);
  assert.ok(s.usdSaved > 0);
});

test("two distinct sessions create two files and lifetime increments twice", async () => {
  await fireHook(searchEvent("a"));
  await fireHook(searchEvent("b"));
  assert.ok(fs.existsSync(path.join(home, ".capex", "session-a.json")));
  assert.ok(fs.existsSync(path.join(home, ".capex", "session-b.json")));
  const lt = readState(path.join(home, ".capex", "lifetime.json"));
  assert.strictEqual(lt.toolCalls, 2);
});

test("10 parallel events do not corrupt JSON", async () => {
  await Promise.all(Array.from({ length: 10 }, () => fireHook(searchEvent("par"))));
  const s = readState(path.join(home, ".capex", "session-par.json"));
  assert.strictEqual(s.toolCalls, 10);
  const lt = readState(path.join(home, ".capex", "lifetime.json"));
  assert.strictEqual(lt.toolCalls, 10);
});

test("SessionStart initializes a fresh session file", async () => {
  await fireHook({ session_id: "init", hook_event_name: "SessionStart", source: "startup" });
  const s = readState(path.join(home, ".capex", "session-init.json"));
  assert.strictEqual(s.toolCalls, 0);
  assert.strictEqual(s.version, 1);
});
