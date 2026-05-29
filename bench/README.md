# CAPEX A/B benchmark

Does CAPEX actually save money over stock Claude Code? This harness answers it
with **real billing data**, not estimates — by running the *same task twice* on
an identical repo (once vanilla, once with the `capex:code` agent) and comparing
Anthropic's own reported token usage.

## Run it

```bash
node bench/run.js                 # REALISTIC multi-step tasks (default), 1 trial
node bench/run.js --trials 3      # average over 3 trials (recommended)
node bench/run.js --tasks feat-currency,add-service
node bench/run.js --isolated      # tool-isolated mode (deny Bash+subagents both arms)
node bench/run.js --model sonnet --keep   # keep fixture working dirs
```

Default tasks are realistic coding-agent work (`feat-currency`, `bugfix-clamp`,
`add-service`, `add-tests`). The table reports cost, fresh tokens, turns, AND
wall-clock time per task, capex vs vanilla. Temp fixtures are auto-cleaned;
`results.json` is git-ignored. See `FINDINGS.md` for the latest verdict (~31%
cost + ~32% token + time savings on realistic tasks).

Requires the `claude` CLI on PATH and an authenticated config. Each run spends
real API budget (a few cents per arm).

## How it works

For each task:

1. `make-fixture.js` writes a deterministic synthetic JS repo to a temp dir
   (a fresh copy per arm, so edits don't leak between runs).
2. Both arms run as headless one-shots: `claude -p "<task>" --output-format json`.
   - **vanilla** — default agent, CAPEX MCP tools denied via `--disallowedTools`,
     so it must use built-in Read/Grep/Glob/Edit (true stock Claude Code).
   - **capex** — `--agent capex:code --plugin-dir <repo>`, using Search/Edit/Read.
3. We locate each run's **session transcript** and sum cumulative token usage
   across every turn (see `../src/transcript.js`), then price it under a
   transparent, tunable schedule.

## Metrics — and which to trust

| Metric | Trust | Why |
|--------|-------|-----|
| **Turns** (`num_turns`) | ⭐ high | Cache-independent; directly reflects roundtrips saved. |
| **Fresh tokens** (input + cache-create + output) | ⭐ high | The non-cache-read work; stable across cache warmth. |
| Cumulative billed tokens | medium | Dominated by cheap cache reads. |
| Transparent cost ($) | medium | Derived from cumulative tokens; better than the CLI number but still moves with cache state. |
| `total_cost_usd` from the CLI | ⚠️ low | **Cumulative**, but carries opaque cache-pricing/retry effects — we saw 5× swings on near-identical token counts. Reported as `cliCostUsd` for reference only. |

**Gotchas this harness handles (learned the hard way):**

- The `usage` block in `claude -p --output-format json` is the **final turn
  only**, not the session total. You must sum the transcript JSONL for
  cumulative usage. (Reporting final-turn usage made CAPEX look 3× worse than
  it was.)
- **Server-side prompt cache warmth** makes whichever arm runs second cheaper.
  The harness alternates arm order across trials to cancel this; still, run
  ≥3 trials and lead with turns + fresh tokens, not raw $.

## Findings (sonnet, 2 trials, 12-file fixture)

| Task | What it exercises | Turns v→c | Fresh tok v→c | Verdict |
|------|-------------------|-----------|---------------|---------|
| `search-imports` | Search vs Grep+Read | 2 → 2–3 | ~0.9k → ~3.6k | vanilla leaner — CAPEX/MCP overhead isn't worth it for a trivial grep on a small repo |
| `batch-rename` | Batched Edit vs N edits | **8–9 → 3** | **~18.6k → ~9.9k** | **CAPEX wins big** — one batched Edit collapses many roundtrips |
| `api-summary` | signatures_only Read | 2 → 2 | ~1.8k → ~2.0k | wash on a small fixture |

**Takeaway:** CAPEX's savings are *real and large* on multi-file mutation
(batched Edit) and should grow with repo size for Search (more files vanilla
would otherwise read one-by-one). On trivial single-step tasks it can cost a
little more. The honest pitch is "saves on the operations that fan out across
many files," not a blanket percentage.

This is exactly why the live savings model (`../src/savings-model.js`) was
rewritten to credit batched Edit strongly, credit Search conservatively, and
price every avoided roundtrip at the session's *real* per-turn context cost.

## Files

- `make-fixture.js` — deterministic fixture generator
- `tasks.js` — task prompts + outcome checks
- `lib/measure.js` — runs one arm, parses cumulative usage + cost
- `run.js` — orchestrator, prints the comparison table, writes `results.json`
