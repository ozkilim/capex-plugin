import { test, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "status-line.js");

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "capex-sl-"));
  fs.mkdirSync(path.join(home, ".capex"), { recursive: true });
});

function run(stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SCRIPT], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ out, code }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function writeSession(id, state) {
  fs.writeFileSync(path.join(home, ".capex", `session-${id}.json`), JSON.stringify(state));
}

test("populated session prints the savings line", async () => {
  writeSession("x", { version: 1, tokensSaved: 4200, roundtripsSaved: 7, msSaved: 3400, usdSaved: 0.123, toolCalls: 5, byTool: {} });
  const { out, code } = await run(JSON.stringify({ session_id: "x" }));
  assert.strictEqual(code, 0);
  assert.match(out, /CAPEX est\. session savings: \$0\.12 · 4\.2k tokens · 3\.4s · 7 roundtrips/);
});

test("no session file prints tracking fallback", async () => {
  const { out } = await run(JSON.stringify({ session_id: "missing" }));
  assert.match(out, /CAPEX: tracking…/);
});

test("corrupt session JSON exits 0 with fallback, never crashes", async () => {
  fs.writeFileSync(path.join(home, ".capex", "session-bad.json"), "{not json");
  const { out, code } = await run(JSON.stringify({ session_id: "bad" }));
  assert.strictEqual(code, 0);
  assert.match(out, /CAPEX: tracking…/);
});
