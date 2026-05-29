# CAPEX benchmark findings

---

# ROUND 3 (2026-05): ten MORE tricks — cold-start, fused verify, re-bill

Round 2 attacked a single tool's output. Round 3 targets the parts of a session
that aren't one tool call: the **cold-start exploration** every task begins
with, the **edit→check→fix** loop, doc-comment bloat, and large command output
that gets **re-billed as cache-read every later turn**.

## The ten tricks, ranked by cost-model leverage

| # | Trick | Attacks | Built |
|---|-------|---------|-------|
| 1 | `Map` — one-call repo skeleton (files + their symbols) | cold-start fresh context + many turns | ✓ new tool |
| 2 | Fused `Edit`/`Insert` parse-check (tree-sitter, no subprocess) | wasted edit→check→fix turns | ✓ |
| 3 | `Read code_only` — drop comment/blank lines | fresh context | ✓ |
| 4 | `Imports` — dependency edges (who imports X / X's imports) | grep→read loop turns | ✓ new tool |
| 5 | `Insert` — AST-anchored insertion, no anchor echo | output + failed-edit retries | ✓ new tool |
| 6 | `Where` — fused Def+Refs in one call | roundtrips | ✓ new tool |
| 7 | `Run` — build/lint/typecheck, errors + exit only | re-billed context | ✓ new tool |
| 8 | Large-file Read guardrail (auto structure over dump) | fresh context | ✓ (read.js) |
| 9 | `Replace` multi-pattern (several renames, one call) | output + turns | ✓ (replace.js) |
| 10 | Agent navigation protocol (Map→Where→View, Run/RunTests not Bash) | output + turns | ✓ (code.md) |

## Deterministic output evidence (free, reproducible: `node bench/measure-output.js`)

| Operation | Old path | New | Output cut |
|-----------|----------|-----|-----------|
| Cold-start orient (34 source files) | read all files: **7909 tok** | `Map` 1 call: **450 tok** | **−94%** |
| Read a doc-padded module | full: **239 tok** | `code_only`: **145 tok** | **−39%** |
| A passing 150-line command | Bash dumps ~**300 tok** | `Run` summary: **23 tok** | **−92%** |

Plus mechanisms without a clean single-number A/B: `Edit`/`Insert` now report
parse status in the same turn (eliminates the separate `node --check` turn and
the retry turn when a break is caught early); `Where` fuses two roundtrips into
one; `Imports` answers wiring questions without reading files.

## End-to-end A/B — the honest arc (this is the interesting part)

The Round-3 tools all win *per call* (table above). End-to-end told a subtler,
more important story.

**Step 1 — naive integration HURT.** First end-to-end run (R2+R3 tools, with an
agent rule "ORIENT with `Map` first before reading anything") on the same 6
tasks: total **−34% cost / −33% tokens** — *worse* than R2's −43% / −36%, and
`add-tests` regressed to **−11% (slower)**.

**Step 2 — a fair test of the cold-start tools exposed why.** New 40-module
task `add-service-lg` (orientation-heavy): capex was **−1.7% cost but +28%
MORE fresh tokens** than vanilla (7.5k vs 5.9k), despite −37% time. Vanilla
grepped the 2–3 files it needed; capex's `Map` pulled the *whole* 40-module
skeleton it didn't need. **The right baseline for `Map` is not "read every
file" (where it wins −94%) but "grep the files you actually need" — and grep
wins for targeted work.** Same law as Round 1's batched-Edit and the api-docs
adversarial case: *returning more than necessary loses, even when one call is
cheaper than reading everything.*

**Step 3 — the fix: restraint, not removal.** Kept every R3 tool (they're
opt-in and genuinely cheaper when you DO need them), but **killed the harmful
default nudge**. The agent rule became "stay surgical; if the task names files,
go straight to them — use `Map` ONLY for genuine whole-repo orientation."

**Step 4 — final run (post-fix), same 6 tasks × 2 trials:**

| Task | Cost v→c | Fresh tok v→c | Turns v→c | Time v→c |
|------|---------|--------------|----------|---------|
| feat-currency | $0.126→$0.049 (**−61%**) | 12.8k→5.4k | 9→3 | 70→18s (−74%) |
| bugfix-clamp | $0.097→$0.046 (**−52%**) | 7.4k→4.3k | 9→4 | 58→24s (−58%) |
| add-service | $0.116→$0.074 (**−36%**) | 11.8k→6.7k | 8→5 | 73→32s (−56%) |
| add-tests | $0.105→$0.087 (−18%) | 9.3k→6.6k | 8→8 | 66→39s (−40%) |
| api-docs* | $0.023→$0.030 (+28%) | 1.6k→2.9k | 2→2 | 46→13s (−71%) | both FAIL verify |
| batch-rename-lg | $0.112→$0.023 (**−79%**) | 9.0k→2.1k | 10→2 | 42→9s (−77%) |
| **TOTAL** | **$0.579→$0.310 (−46%)** | **51.9k→28.0k (−46%)** | | **355→136s (−62%)** |

*api-docs: both arms again failed `expectMentions` (adversarial enumerate case);
not a valid A/B.

**−46% cost / −46% tokens / −62% time, winning 5/6** — the best realistic-task
numbers in the project, and notably better on TOKENS than the Round-2 bar
(−36%). Restraint recovered and improved on R2.

### Per-trick verdict (Round 3)
- **`Run` — KEEP.** −92% output on a passing command; clear win whenever a
  verification command would print a lot. Opt-in, never hurts.
- **`Read code_only` — KEEP (opt-in).** −39% on doc-padded files.
- **Fused Edit/Insert parse-check — KEEP.** ~free (tree-sitter, no subprocess);
  catches breakage in-turn. No output downside.
- **`Insert` / `Where` / `Imports` — KEEP (opt-in).** Useful for additions /
  symbol tracing; deterministically cheaper than the read-heavy alternative.
- **`Replace` multi-pattern — KEEP.** Extends the Round-2 winner.
- **Large-file Read guardrail — KEEP.** Only fires >800 lines; pure guardrail.
- **`Map` the TOOL — KEEP; the "Map-first" HEURISTIC — KILLED.** This is the
  headline lesson of Round 3: a tool that's −94% vs the worst case can still be
  net-negative if the prompt makes the agent use it when a targeted grep would
  do. Map stays for genuine whole-repo orientation; the agent no longer reaches
  for it by default.

### Skeptic's caveats
- 2 trials; cache + sampling noise is large (vanilla feat-currency $0.107–$0.144;
  one vanilla add-tests run even failed to create a test file). Trust turns
  (9→3, 10→2) and the deterministic per-call cuts over any single $.
- The win is the integrated R1+R2+R3 system vs stock; individual R3 tricks were
  validated by deterministic output measurement, not isolated end-to-end A/B
  (except the Map-first heuristic, which the large-repo task isolated — and it
  lost, which is why it was removed).
- Part of the gain remains the leaner `capex:code` agent in a tool-bloated env.

---

# ROUND 2 (2026-05): ten new cost-saving tricks

Goal: attack the two expensive terms in `cost ≈ cheap cache-read + 5× OUTPUT`
— i.e. cut **output tokens** and **wasted turns**, not just roundtrips. Ten
tricks were proposed, ranked by that model, implemented, and tested.

## The ten tricks, ranked by cost-model leverage

| # | Trick | Attacks | Built | Verdict |
|---|-------|---------|-------|---------|
| 1 | `Replace` — server-side multi-file find/replace, 1-line summary | OUTPUT + turns | ✓ | see below |
| 2 | Terse `Search` default (`file:line: text`, context opt-in) | OUTPUT + cache re-bill | ✓ | see below |
| 3 | `RunTests` — run suite, return only failures + counts | OUTPUT | ✓ | see below |
| 4 | `View` — symbol-scoped read (one function via AST) | fresh context + turns | ✓ | see below |
| 5 | `Outline detail:"names"` — compact symbol inventory | OUTPUT | ✓ | see below |
| 6 | Edit near-match hints on failure | wasted turns | ✓ | see below |
| 7 | Multi-file `Read` (`files[]` in one call) | turns (cheap) | ✓ | folded in |
| 8 | Search auto-summary for huge match sets | OUTPUT | partial (terse covers it) | folded |
| 9 | Agent-prompt refresh (steer to new tools + "return minimal") | OUTPUT + turns | ✓ | folded in |
| 10 | Large-file read guardrail (auto-signatures) | fresh context | via existing signatures_only | folded |

## Deterministic output-size evidence (free, reproducible, no API spend)

The cost model says the reliable lever is OUTPUT. Measured directly on the
24-module fixture (tokens ≈ chars/4), comparing each new tool to the path the
model would otherwise take:

| Operation | Old path | New tool | Output cut |
|-----------|----------|----------|-----------|
| Rename `computeTotal` (80 occ, 28 files) | batched-Edit echoes the edits array: **714 tok** | `Replace` summary: **183 tok** | **−74%** |
| `Search "logger"` (67 hits) | verbose ctx=2: **3457 tok** | terse default: **1057 tok** | **−69%** |
| `Outline src/` (34 files, 91 symbols) | detail=sig: **950 tok** | detail=names: **645 tok** | **−32%** |
| Read one symbol from money.js | full Read: **236 tok** | `View`: **28 tok** | **−88%** |

These are the per-call output reductions; since output is priced 5× input and is
re-billed as cache-read on every later turn, they compound across a session.
The Replace number is conservative — it counts only the *result*; the bigger win
is the model no longer **generating** the 28-element edits array as 5× output.

Reproduce: `node bench/measure-output.js` (deterministic).

## End-to-end A/B (vanilla vs new-CAPEX), deduped, 6 tasks × 2 trials

Product mode (stock Claude Code vs `capex:code` with all Round-2 tricks). Full
toolset both arms; vanilla denies all 11 CAPEX MCP tools so it falls back to
built-ins. `node bench/run.js --tasks feat-currency,bugfix-clamp,add-service,add-tests,batch-rename-lg,api-docs --trials 2`.

| Task | Cost v→c | Fresh tok v→c | Turns v→c | Time v→c | Read |
|------|---------|--------------|----------|---------|------|
| feat-currency | $0.107→$0.051 (**−52%**) | 9.7k→6.3k | 9→3 | 59→19s (−67%) | win |
| bugfix-clamp | $0.107→$0.044 (**−59%**) | 7.9k→4.5k | 10→4 | 50→18s (−65%) | win |
| add-service | $0.096→$0.078 (−19%) | 7.6k→7.3k | 9→6 | 70→37s (−47%) | win |
| add-tests | $0.127→$0.081 (**−36%**) | 11.8k→6.4k | 9→8 | 60→36s (−41%) | win |
| batch-rename-lg | $0.074→$0.022 (**−71%**) | 6.6k→2.0k | 7→2 | 36→10s (−73%) | **win (was a LOSS in R1)** |
| api-docs* | $0.027→$0.029 (+8%) | 2.6k→2.9k | 2→2 | 58→13s (−77%) | both FAILED verify |
| **TOTAL** | **$0.539→$0.305 (−43%)** | **46.2k→29.4k (−36%)** | | **333→133s (−60%)** | **5/5 valid tasks won** |

*api-docs: BOTH arms failed `expectMentions` (each summarized the repo instead of
listing all 30 modules' symbols), so that row is not a valid A/B — it's the known
adversarial "enumerate everything" case, not a regression from these changes.
Excluding it, CAPEX won every task. Even there CAPEX was 77% faster.

### Honest verdict per trick

- **`Replace` — KEEP, headline win.** `batch-rename-lg` was a **loss** in Round 1
  (+30% to +56%: batched Edit re-emitted the edits array as 5× output). With
  server-side Replace it is now **−71% cost / −69% tokens / 7→2 turns**. This is
  the cleanest causal result in the whole project: same task, the one change
  that flips a documented loss into a decisive win — exactly what the cost model
  predicted (kill the output term).
- **Terse `Search` — KEEP.** −69% output per call (deterministic). Contributes to
  the feat-currency / bugfix wins; no task regressed.
- **`RunTests` — KEEP.** add-tests improved to −36% cost / −46% tokens; the tool
  keeps the runner's full passing-test stream out of context.
- **`View` — KEEP.** −89% output vs a full read for one symbol; supports the
  locate-and-fix wins (bugfix-clamp −59%).
- **`Outline detail:"names"` — KEEP (opt-in, low risk).** −32% output
  deterministically; not provable end-to-end because api-docs failed both arms.
- **Edit near-match hints — KEEP.** Pure-win design (no output downside); not
  isolated end-to-end but cannot regress.
- **Multi-file Read / agent-prompt refresh — KEEP (folded in).**
- **No KILLs:** every change is opt-in or strictly reduces output, so none
  regressed a task. The only non-win is the adversarial api-docs (both arms).

### Skeptic's caveats (don't overclaim)
- **2 trials → real cache noise.** vanilla feat-currency swung $0.085→$0.130
  across trials; treat ±10% on any single $ delta as noise. The robust signals
  are turns (9→3, 10→4, 7→2) and the deterministic output cuts.
- On the 5-task subset comparable to the Round-1 bar (excl. rename), this run is
  −39% cost / −31% tokens — in the same band as the prior −48% / −45%, i.e. the
  integrated system did **not** beat the old headline on those exact tasks; the
  genuine *new* gain is Replace rescuing the rename case and the per-call output
  reductions, not a higher aggregate number on the old mix.
- Part of the win remains the `capex:code` agent being leaner in a tool-bloated
  global env (it burns fewer exploratory turns), not purely the file tools.
- Tricks were screened by **deterministic output measurement** (mechanism, free,
  noise-free) plus end-to-end totals; each trick was **not** individually
  A/B'd end-to-end (that needs capex-with vs capex-without per trick, doubling
  spend). `batch-rename-lg` is the exception — it isolates `Replace` cleanly.

---

Honest, reproducible A/B (`bench/run.js`) measuring stock Claude Code vs the
`capex:code` agent on identical tasks, using Anthropic's real cumulative token
usage from session transcripts. Model: sonnet. Metrics to trust: **turns** and
**fresh tokens** (input + cache-create + output); raw $ is cache-warmth-noisy.

## Results

### Small fixture (12 files), 1 trial
| Task | Cost v→c | Turns v→c | Read |
|------|----------|-----------|------|
| search-imports | $0.016 → $0.016 | 2 → 2 | even |
| batch-rename | $0.105 → $0.082 | 5 → 3 | CAPEX win |
| api-summary | $0.015 → $0.024 | 2 → 2 | CAPEX lost |

### Large fixture (40 / 24 modules), 2 trials
| Task | Cost v→c | Fresh v→c | Turns v→c | Read |
|------|----------|-----------|-----------|------|
| search-imports-lg | $0.031 → $0.048 (**+56%**) | 3.7k → 5.3k | 2 → 3 | CAPEX lost |
| batch-rename-lg | $0.171 → $0.222 (**+30%**) | 26.6k → 31.1k | 5 → 3 | CAPEX lost |
| api-summary-lg | $0.067 → $0.068 (−1%) | 7.4k → 8.8k | 4 → 3 | tie |
| **TOTAL** | **$0.269 → $0.338 (+25%)** | 37.6k → 45.2k | | **CAPEX lost** |

## Verdict

Against a capable model (Sonnet) that already uses Grep/sed/Bash well, the
current CAPEX tools **do not reliably save money and at scale cost ~25% more.**
The earlier small-repo "win" on batch-rename did not generalize.

## Why — three precise mechanisms

1. **Batched Edit pays in output tokens (5× input price).** On batch-rename-lg,
   CAPEX emitted ~3× the output of vanilla (the 28-element `edits` array). The
   extra output (~3,800 tok × $15/Mtok ≈ $0.057) *exactly* accounts for the
   per-run cost gap. Roundtrips saved (5→3) bought nothing because the saving
   was repaid, at 5×, in the assistant message.
2. **Content-returning Search inflates cache + output.** Verbose match context
   is re-billed as cache-read every subsequent turn and bloats output. Vanilla's
   Grep returns terse hits.
3. **The naive pattern CAPEX optimizes often doesn't happen.** A capable model
   reaches for `sed`/`grep`/`MultiEdit` and resolves multi-file work in 2–3
   turns on its own, so there are few "grep→read→edit-loop" roundtrips to save.

## What this means for the product

The thesis "fewer roundtrips = less money" is **incomplete**: a tool call's cost
is `(re-billed context: mostly cheap cache-read) + (output: 5× input)`. CAPEX
currently *adds* to the two expensive terms (output + fresh context) to save the
cheap one (roundtrips). To reliably shave cost, optimize the expensive terms.

## Roadmap — reprioritized by this evidence

1. **Server-side pattern replace** `replace(glob, old, new)` — do the multi-file
   rename in the tool, return a one-line summary (`"renamed in 28 files"`).
   Turns a 6,000-token output into ~15 tokens. Directly fixes mechanism #1 and
   would beat both vanilla-sed and CAPEX-Edit. **Highest leverage.**
2. **Make Search terse by default** — return paths + `file:line` only; verbose
   context opt-in. Fixes mechanism #2 (less cache-read re-billing, less output).
3. **Retroactive transcript scanner** (Woz-style `detect*`) — scan real
   `~/.claude` transcripts for grep→read / glob→read / failed-edit / bash-sql
   patterns to measure *actual* waste in real sessions, rather than assume it.
   Honest measurement + targets the cases that truly occur.
4. **Cost model must weight output 5×.** The savings model (now roundtrip-based)
   should subtract the output cost of large tool I/O, or it will overstate wins.
5. **Failed-edit elimination** — robust whitespace-tolerant Edit avoids the
   error→read→retry loop (2–4 wasted turns each). Likely a real, underseen win;
   needs a dedicated benchmark to confirm.

## MEASUREMENT FIX: transcript dedup (prior numbers were inflated)

Claude Code logs some assistant messages multiple times (streaming partials /
retries sharing a `message.id`). The token summer counted every line, inflating
token/cost figures ~2-3x — unevenly per arm, so earlier deltas were noisy. Fixed
by deduping on `message.id`/`requestId` in `src/transcript.js` (and tool_uses in
`src/scan.js`). Example: a capex feat-currency run that summed to 80k "fresh"
tokens is really **6.7k** once deduped. All benchmarks below the next header use
the corrected, deduplicated measurement.

## FULL WOZ TRICK SET now in CAPEX

Tools (8): Search, batched Edit, Read/`signatures_only`, Write, **Outline**
(AST symbols), **Refs** (call sites), **Def** (definition), **Sql** (SQLite
query/schema, dialect-rewriting). Plus a retroactive **savings scanner**
(`scripts/savings-scan.js` + `src/scan.js`) that scores grep→read / read-batch /
edit-batch / failed-edit / bash-sql patterns in real `~/.claude` transcripts.
Deliberately NOT copied: PostHog telemetry (privacy is the differentiator),
spinner verbs, free-plan gating. 57 tests pass.

## ✅ HEADLINE: full beefed CAPEX vs vanilla, deduped (larger benchmark)

All Woz tricks enabled, corrected (deduplicated) measurement, 5 realistic
multi-step tasks × 2 trials, full toolset both arms, real verification.

| Task | Cost v→c | Fresh tok v→c | Turns v→c | Time v→c |
|------|---------|--------------|----------|---------|
| feat-currency | $0.111→$0.044 (**−60%**) | 10.5k→4.1k | 8→5 | 69→21s (−69%) |
| bugfix-clamp | $0.091→$0.050 (**−45%**) | 7.9k→5.1k | 8→4 | 40→21s (−47%) |
| add-service | $0.169→$0.074 (**−56%**) | 17.1k→7.3k | 11→9 | 99→29s (−70%) |
| add-tests | $0.151→$0.084 (**−45%**) | 12.8k→7.5k | 12→7 | 70→37s (−48%) |
| api-docs (enumerate all) | $0.024→$0.031 (+27%) | 1.7k→3.6k | 2→2 | 49→12s (−76%) |
| **TOTAL** | **$0.546→$0.282 (−48%)** | **49.9k→27.7k (−45%)** | | **326→120s (−63%)** |

**Verdict: with every Woz trick implemented, CAPEX cuts cost ~48%, tokens ~45%,
and wall-time ~63% on realistic coding tasks** — winning 4/5 decisively. The only
loss is the adversarial “list every symbol in the repo” task (output is
inherently large), and even there CAPEX is 76% faster. This is the honest,
deduplicated, subagent-inclusive number.

## REAL EVAL (pre-dedup, inflated — see fix above)

Harness now sums EVERY transcript in each run's project dir (main + any
sub-agent sessions), so nothing is off-book; `total_cost_usd` cross-checks.
Full CAPEX system incl. the new AST `Outline` tool. 5 realistic tasks, 2 trials.

| Task | Cost v→c | Fresh tok v→c | Turns v→c | Time v→c |
|------|---------|--------------|----------|---------|
| feat-currency | $0.18→$0.12 (−35%) | 16.7k→12.2k | 9→6 | 74→21s (−72%) |
| bugfix-clamp | $0.10→$0.10 (−5%) | 8.0k→11.4k (+42%) | 7→5 | 47→24s (−50%) |
| add-service | $0.20→$0.18 (−13%) | 19.7k→19.5k | 9→8 | 65→37s (−44%) |
| add-tests | $0.31→$0.24 (−22%) | 25.0k→21.4k | 11→9 | 76→50s (−34%) |
| api-docs (Outline) | $0.033→$0.034 (~0) | 2.1k→2.6k | 2→2 | 48→13s (−73%) |
| **TOTAL** | **$0.83→$0.67 (−19%)** | **71.6k→67.1k (−6%)** | | **310→144s (−54%)** |

### Honest verdict
- **Speed is the dominant, reliable win: ~54% less wall-clock time**, on EVERY
  task. Vanilla burns turns on `ToolSearch` (5–6×) + `Bash` (5–11×) spelunking;
  CAPEX does clean Search/Read/Edit. CAPEX is also far lower-variance.
- **Cost: ~19% cheaper** (real billing, subagent-inclusive). Solid, more variable.
- **Tokens: roughly neutral (−6%)** — once a capable vanilla agent is free to use
  lean `Bash`/grep, CAPEX is NOT dramatically fewer tokens. The earlier
  “−31% tokens” overstated it; this subagent-inclusive number is the truth.
- **`Outline`**: massive speed win on structure tasks (api-docs 48→13s) but a
  slight token cost when asked to enumerate everything — best used surgically.
- Sub-agent counts were 0 (the `Agent` calls didn't spawn separate-file
  sessions), so the measurement is complete.

**Marketing implication: lead with SPEED (≈half the time) and cost (~20%), not
token count.** That's the defensible, reproducible claim.

## (earlier) REALISTIC tasks, pre-fix — token metric undercounted subagents

The micro-op tasks above are NOT what a coding agent does. Re-ran with realistic
multi-step tasks (explore → edit across files → must still parse / pass tests),
product mode, full toolset both arms, 2 trials. Every run passed verification.

| Task | Cost v→c | Fresh tok v→c | Turns v→c |
|------|---------|--------------|----------|
| feat-currency (multi-file feature) | $0.27 → $0.14 (**−49%**) | 34.4k → 16.1k | 9 → 6 |
| bugfix-clamp (locate + fix) | $0.12 → $0.10 (−20%) | 13.4k → 10.3k | 6 → 5 |
| add-service (create + wire in) | $0.28 → $0.18 (**−37%**) | 27.2k → 19.5k | 11 → 8 |
| add-tests (author passing tests) | $0.22 → $0.21 (−8%) | 22.5k → 20.8k | 11 → 8 |
| **TOTAL** | **$0.90 → $0.62 (−31%)** | **97.5k → 66.7k (−32%)** | |

CAPEX won every task on cost, fresh tokens, AND turns — and was far
lower-variance (vanilla swung $0.14–$0.42 on add-service; CAPEX stayed tight).
**The earlier negative verdict was a task-design artifact: micro-ops can't show
where CAPEX helps. On realistic exploration-heavy work it clearly does.**

### But: a confound in the OTHER direction (be honest)
Per-arm tool usage:
- **vanilla** leaned on `ToolSearch` (5–9×/task) and spawned `Agent` subagents
  (2–4×) — both heavy — because this machine's global config exposes dozens of
  unrelated MCP servers (Notion, Canva, Chrome, …) as deferred tools.
- **capex** used clean `Search`/`Read`/`Edit`/`Write` and largely avoided
  ToolSearch/subagents.

So part of the 31% is `capex:code` being a *leaner agent* in a tool-bloated
environment, not purely better file tools. The file-tool contribution alone is
smaller but still positive — see `bugfix-clamp` (least exploration-heavy, still
−20%). To isolate it, re-run denying `Agent`+`ToolSearch` on both arms.

## Apples-to-apples correction — micro-op runs (earlier)

Inspecting the transcripts showed the large-repo A/B was **not** isolating the
tools:

- **vanilla** rename used `Bash` (`grep -rl ... | sed`) — rewrote 24 files in one
  shell command, ~3 cheap turns.
- **capex** rename used `Search` + `Edit` because the `capex:code` agent prompt
  says "batch all edits into ONE Edit call" — forcing the expensive structured
  path and emitting a 28-element edits array as 5×-priced output.

So we compared *"model free to use sed"* vs *"model steered onto CAPEX Edit."*
Two distinct questions need two arms:
  - **Product test** (shipped CAPEX agent vs stock): valid, and CAPEX loses today.
  - **Tool test** (same agent, only the file-tools swapped, Bash denied on both):
    isolates whether the *tools* are more efficient. Not yet run.

Lesson: a structured Edit that echoes its edits can't beat `sed`. To reliably
beat vanilla, the tool must do the mutation server-side and return a tiny diff.

## Woz's actual methodology (decompiled from standalone/savings-check.js)

Woz does **not** run A/B tests. Its savings claim is **retroactive pattern
detection** over real session transcripts:

1. Parse the transcript into turns (assistant msg + its tool_uses + real usage);
   mark `isVanilla=false` once any woz MCP tool is used; mark an edit failed via
   the tool_result `is_error` flag.
2. Detect inefficiency "hits" — vanilla sequences its tools would collapse:
   - `detectGrepRead`/`detectGlobRead`: a Grep/Glob then Read(s) within 3 turns
     → `callsSaved = #reads` (Search returns content, no follow-up reads).
   - `detectReadBatch`: ≥2 consecutive Reads → `callsSaved = reads-1`.
   - `detectEditBatch`: ≥2 Edits in a run → collapse to 1–2 calls.
   - `detectFailedEdit`: errored Edit + read/retry loop → `callsSaved = len-1`.
   - `detectBashSql`: ≥2 Bash `psql|sqlite3|mysql|duckdb` calls → one `Sql` call.
   - a `consumed` set prevents double counting (failedEdit > grep/glob > sql >
     editBatch > readBatch).
3. Price each saved call at the session's REAL average per-turn cost:
   `perCallTokens = (avgInput + avgCacheRead + avgCacheCreation) × 1.3 + avgOutput`,
   priced per-token (cache-read at ~10%), `time = calls × 7s`.

**Hidden flaw in Woz's claim:** it prices the *saved* calls but assumes the
replacement woz call costs ~nothing extra — it ignores the replacement tool's
own output tokens. That's exactly the cost our A/B caught in CAPEX's batched
Edit. So Woz likely **overstates** savings; an A/B (what we built) is stricter.

**What Woz's design gets right (adopt these):** terse/targeted tools, the
failed-edit elimination (pure win, no output downside), and a dedicated `Sql`
tool. Their headline number is plausible only for heavy users with many real
grep→read / failed-edit sequences.

## How to RELIABLY shave cost (synthesis)

A tool call costs `re-billed context (mostly cheap cache-read) + output (5×)`.
Reliable savings come only from levers that don't repay themselves in output:

1. **Server-side `replace(glob, old, new)`** returning a 1-line summary — beats
   sed (safe/structural) AND batched Edit (no output bloat). Highest leverage.
2. **Failed-edit elimination** — robust first-try edits remove error→reread→retry
   loops (2–4 turns each). No output downside. Most reliable per Woz.
3. **Terse, targeted returns** — Search/Read should return the minimum (paths,
   `file:line`, signatures); verbose context opt-in. Less output + less re-bill.
4. **NOT raw edit-batching** — net-negative when output > roundtrips saved.

## Caveats (be fair to CAPEX)

- One model (Sonnet), synthetic fixture, 2 trials — cache noise is large.
- CAPEX may help weaker models, or long agentic loops where naive reads recur.
- Its value may be **guardrails/context-compression** (signatures_only) more
  than roundtrip reduction. api-summary was the only non-loss — worth pursuing.
