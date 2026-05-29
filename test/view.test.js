import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doView } from "../src/view.js";

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-view-"));
  fs.writeFileSync(
    path.join(dir, "m.js"),
    "// header\nexport function alpha(x) {\n  return x + 1;\n}\n\nexport function beta(y) {\n  return y * 2;\n}\n"
  );
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("View returns only the requested symbol's body", async () => {
  const r = await doView({ file: "m.js", symbol: "beta", cwd: dir });
  assert.strictEqual(r.meta.mode, "view");
  assert.strictEqual(r.meta.found, 1);
  assert.ok(r.text.includes("function beta"));
  assert.ok(!r.text.includes("function alpha"), "did not leak other symbols");
  assert.ok(r.meta.linesReturned < r.meta.totalLines);
});

test("View on a missing symbol lists available symbols as a hint", async () => {
  const r = await doView({ file: "m.js", symbol: "gamma", cwd: dir });
  assert.strictEqual(r.meta.found, 0);
  assert.match(r.text, /No definition of `gamma`/);
  assert.ok(r.text.includes("alpha") && r.text.includes("beta"));
});
