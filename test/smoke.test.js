import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = path.join(__dirname, "..", "scripts", "smoketest.js");

test("MCP server smoke test passes end-to-end", async () => {
  const code = await new Promise((resolve, reject) => {
    const child = spawn("node", [SMOKE], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (c) => resolve(c));
  });
  assert.strictEqual(code, 0, "smoketest.js should exit 0");
});
