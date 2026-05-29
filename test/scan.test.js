import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEvents, scanTranscript } from "../src/scan.js";

// Build a minimal transcript JSONL from a list of assistant tool_uses, with
// tool_result follow-ups carrying is_error.
function transcript(steps) {
  const lines = [];
  let id = 0;
  for (const step of steps) {
    const content = step.tools.map((t) => ({ type: "tool_use", id: "t" + ++id, name: t.name, input: t.input || {} }));
    lines.push(JSON.stringify({ type: "assistant", message: { content, usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 50 } } }));
    const results = step.tools.map((t, i) => ({ type: "tool_result", tool_use_id: "t" + (id - step.tools.length + i + 1), is_error: !!t.error }));
    lines.push(JSON.stringify({ type: "user", message: { content: results } }));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-scan-"));
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, lines.join("\n"));
  return f;
}

test("parseEvents splits on real user messages", () => {
  const f = transcript([{ tools: [{ name: "Grep" }] }]);
  const text = fs.readFileSync(f, "utf8") + "\n" + JSON.stringify({ type: "user", message: { content: "do something else" } });
  const segs = parseEvents(text);
  assert.ok(segs.length >= 1);
});

test("detects grep->read as collapsible", () => {
  const f = transcript([{ tools: [{ name: "Grep" }] }, { tools: [{ name: "Read" }] }, { tools: [{ name: "Read" }] }]);
  const r = scanTranscript(f);
  assert.ok(r.byType.grep_read >= 2, JSON.stringify(r.byType));
  assert.ok(r.callsSaved >= 2);
});

test("detects failed-edit retry loop", () => {
  const f = transcript([{ tools: [{ name: "Edit", error: true }] }, { tools: [{ name: "Read" }] }, { tools: [{ name: "Edit" }] }]);
  const r = scanTranscript(f);
  assert.ok(r.byType.failed_edit >= 1, JSON.stringify(r.byType));
});

test("detects repeated sqlite Bash as bash_sql", () => {
  const f = transcript([
    { tools: [{ name: "Bash", input: { command: "sqlite3 app.db 'select 1'" } }] },
    { tools: [{ name: "Bash", input: { command: "sqlite3 app.db 'select 2'" } }] },
  ]);
  const r = scanTranscript(f);
  assert.ok(r.byType.bash_sql >= 1, JSON.stringify(r.byType));
});

test("clean session yields no savings", () => {
  const f = transcript([{ tools: [{ name: "Bash", input: { command: "ls" } }] }]);
  const r = scanTranscript(f);
  assert.strictEqual(r.callsSaved, 0);
});
