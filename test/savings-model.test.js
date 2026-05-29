import { test } from "node:test";
import assert from "node:assert";
import {
  estimateSavings,
  PRICE_INPUT_PER_MTOK,
  FALLBACK_ROUNDTRIP_TOKENS,
} from "../src/savings-model.js";

// --- edit: the strong, repeatable win -------------------------------------
test("edit mode credits one roundtrip per edit beyond the first", () => {
  const r = estimateSavings({ mode: "edit", batchSize: 3 });
  assert.strictEqual(r.roundtripsSaved, 2);
  assert.strictEqual(r.tokensSaved, 2 * FALLBACK_ROUNDTRIP_TOKENS);
});

test("edit of size 1 saves nothing", () => {
  const r = estimateSavings({ mode: "edit", batchSize: 1 });
  assert.strictEqual(r.tokensSaved, 0);
  assert.strictEqual(r.roundtripsSaved, 0);
});

// --- search: now conservative (was inflated to 3 per search) --------------
test("search with matches credits at most one roundtrip", () => {
  const r = estimateSavings({ mode: "search", matches: 3 });
  assert.strictEqual(r.roundtripsSaved, 1);
});

test("search with no matches saves nothing", () => {
  const r = estimateSavings({ mode: "search", matches: 0 });
  assert.strictEqual(r.roundtripsSaved, 0);
  assert.strictEqual(r.tokensSaved, 0);
});

// --- live transcript context overrides the flat constant ------------------
test("roundtrip pricing uses live per-turn context when provided", () => {
  const ctx = { perRoundtripTokens: 9000, perRoundtripUsd: 0.02 };
  const r = estimateSavings({ mode: "edit", batchSize: 4 }, ctx);
  assert.strictEqual(r.roundtripsSaved, 3);
  assert.strictEqual(r.tokensSaved, 3 * 9000);
  assert.ok(Math.abs(r.usdSaved - 3 * 0.02) < 1e-9);
});

// --- read: a context-size saving, not a roundtrip -------------------------
test("read signatures_only saves ~70% of file tokens", () => {
  const r = estimateSavings({ mode: "read", signaturesOnly: true, totalLines: 100 });
  assert.strictEqual(r.tokensSaved, Math.round(100 * 10 * 0.7));
  assert.strictEqual(r.roundtripsSaved, 0);
});

test("read full non-truncated saves nothing", () => {
  const r = estimateSavings({ mode: "read", truncated: false, signaturesOnly: false, totalLines: 100 });
  assert.strictEqual(r.tokensSaved, 0);
});

test("read usd derives from input price", () => {
  const r = estimateSavings({ mode: "read", signaturesOnly: true, totalLines: 50 });
  assert.ok(Math.abs(r.usdSaved - (r.tokensSaved / 1e6) * PRICE_INPUT_PER_MTOK) < 1e-9);
});

test("outline credits context + roundtrip savings", () => {
  const r = estimateSavings({ mode: "outline", files: 3, linesElided: 200 });
  assert.strictEqual(r.roundtripsSaved, 2); // files - 1
  assert.ok(r.tokensSaved > Math.round(200 * 10 * 0.8)); // ctx + roundtrips
});

test("unknown mode returns zero", () => {
  const r = estimateSavings({ mode: "nope" });
  assert.deepStrictEqual(r, { tokensSaved: 0, roundtripsSaved: 0, msSaved: 0, usdSaved: 0 });
});
