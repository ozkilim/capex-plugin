// Standalone end-to-end smoke test for the CAPEX MCP server.
// Spawns the server over stdio, sends initialize + tools/list + tools/call,
// and asserts the shapes. Run via `node scripts/smoketest.js`.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "servers", "code-server.js");

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    const pending = new Map();

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });

    child.on("error", reject);

    let nextId = 1;
    function send(method, params) {
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    (async () => {
      try {
        await send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoketest", version: "0.0.0" }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

        const list = await send("tools/list", {});
        const names = (list.result?.tools || []).map((t) => t.name).sort();
        assert.deepStrictEqual(names, ["Def", "Edit", "Imports", "Insert", "Map", "Outline", "Read", "Refs", "Replace", "Run", "RunTests", "Search", "Sql", "View", "Where", "Write"], "expected sixteen tools");

        const call = await send("tools/call", {
          name: "Search",
          arguments: { file_glob_patterns: ["src/*.js"], content_regex: "export", cwd: path.join(__dirname, "..") }
        });
        const meta = call.result?._meta?.capex;
        assert.ok(meta && meta.mode === "search", "Search call returned capex meta");
        assert.ok(typeof call.result.content[0].text === "string", "Search returned text content");

        child.kill();
        resolve({ names, meta });
      } catch (err) {
        child.kill();
        reject(err);
      }
    })();
  });
}

runSmoke()
  .then(({ names, meta }) => {
    console.log("SMOKE OK");
    console.log("tools:", names.join(", "));
    console.log("Search meta:", JSON.stringify(meta));
  })
  .catch((err) => {
    console.error("SMOKE FAILED:", err.message);
    process.exit(1);
  });
