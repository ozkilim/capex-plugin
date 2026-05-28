import { test } from "node:test";
import assert from "node:assert";
import { estimateSavings, PRICE_INPUT_PER_MTOK, VANILLA_PER_ROUNDTRIP_TOKENS } from "../src/savings-model.js";

test("search mode returns roundtrips and tokens", () => {
  const r = estimateSavings({ mode: "search", matches: 3, filesScanned: 10 });
  assert.strictEqual(r.roundtripsSaved, 3);
  assert.ok(r.tokensSaved >= 3 * VANILLA_PER_ROUNDTRIP_TOKENS);
  assert.strictEqual(r.msSaved, 4000);
  assert.ok(Math.abs(r.usdSaved - (r.tokensSaved / 1e6) * PRICE_INPUT_PER_MTOK) < 1e-9);
});

test("search caps matches contribution at 5", () => {
  const a = estimateSavings({ mode: "search", matches: 5 });
  const b = estimateSavings({ mode: "search", matches: 100 });
  assert.strictEqual(a.tokensSaved, b.tokensSaved);
});

test("edit mode scales with batch size", () => {
  const r = estimateSavings({ mode: "edit", batchSize: 3 });
  assert.strictEqual(r.roundtripsSaved, 2);
  assert.strictEqual(r.tokensSaved, 2 * VANILLA_PER_ROUNDTRIP_TOKENS);
});

test("edit of size 1 saves nothing", () => {
  const r = estimateSavings({ mode: "edit", batchSize: 1 });
  assert.strictEqual(r.tokensSaved, 0);
  assert.strictEqual(r.roundtripsSaved, 0);
});

test("read signatures_only saves ~70% of file tokens", () => {
  const r = estimateSavings({ mode: "read", signaturesOnly: true, totalLines: 100 });
  assert.strictEqual(r.tokensSaved, Math.round(100 * 10 * 0.7));
});

test("read full non-truncated saves nothing", () => {
  const r = estimateSavings({ mode: "read", truncated: false, signaturesOnly: false, totalLines: 100 });
  assert.strictEqual(r.tokensSaved, 0);
});

test("usd equals tokens/1e6 * price for all modes", () => {
  for (const meta of [
    { mode: "search", matches: 2 },
    { mode: "edit", batchSize: 4 },
    { mode: "read", signaturesOnly: true, totalLines: 50 }
  ]) {
    const r = estimateSavings(meta);
    assert.ok(Math.abs(r.usdSaved - (r.tokensSaved / 1e6) * PRICE_INPUT_PER_MTOK) < 1e-9);
  }
});

test("unknown mode returns zero", () => {
  const r = estimateSavings({ mode: "nope" });
  assert.deepStrictEqual(r, { tokensSaved: 0, roundtripsSaved: 0, msSaved: 0, usdSaved: 0 });
});
