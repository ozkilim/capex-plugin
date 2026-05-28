import { test, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "scripts", "capex-cli.js");

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "capex-remote-"));
});

// remote.js reads HOME at call time via paths.js, so set it before importing.
async function withHome(fn) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await import(`../src/remote.js?t=${Date.now()}`);
    return await fn(mod);
  } finally {
    process.env.HOME = prev;
  }
}

test("ensureMachine creates a stable id", async () => {
  await withHome(async ({ ensureMachine }) => {
    const a = ensureMachine();
    const b = ensureMachine();
    assert.ok(a.machineId);
    assert.strictEqual(a.machineId, b.machineId);
    assert.ok(a.label);
  });
});

test("saveAuth/loadAuth/clearAuth roundtrip", async () => {
  await withHome(async ({ saveAuth, loadAuth, clearAuth }) => {
    saveAuth({ token: "cpx_sk_abc", apiUrl: "http://x" });
    assert.strictEqual(loadAuth().token, "cpx_sk_abc");
    clearAuth();
    assert.strictEqual(loadAuth(), null);
  });
});

test("buildSavingsPayload maps lifetime totals", async () => {
  await withHome(async ({ buildSavingsPayload }) => {
    const p = buildSavingsPayload(
      { tokensSaved: 100, usdSaved: 0.3, roundtripsSaved: 2, msSaved: 4000, toolCalls: 5, byTool: { Search: 5 } },
      { machineId: "m1", label: "host" }
    );
    assert.strictEqual(p.machineId, "m1");
    assert.strictEqual(p.tokensSaved, 100);
    assert.strictEqual(p.toolCalls, 5);
    assert.deepStrictEqual(p.byTool, { Search: 5 });
  });
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("cli login writes auth.json; rejects bad token", async () => {
  const bad = await runCli(["login", "--token", "nope"]);
  assert.strictEqual(bad.code, 1);
  assert.ok(!fs.existsSync(path.join(home, ".capex", "auth.json")));

  const ok = await runCli(["login", "--token", "cpx_sk_test123", "--url", "http://localhost:3000"]);
  assert.strictEqual(ok.code, 0);
  const auth = JSON.parse(fs.readFileSync(path.join(home, ".capex", "auth.json"), "utf8"));
  assert.strictEqual(auth.token, "cpx_sk_test123");
  assert.strictEqual(auth.apiUrl, "http://localhost:3000");
});
