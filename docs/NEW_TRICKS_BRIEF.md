# Brief: invent, implement & benchmark 10 new cost-saving tricks for CAPEX

You are a coding agent picking up an existing project cold. Read this whole
brief first — it gives you the context, the architecture, the hard-won
principles, and exactly how to run the eval. Then do the task at the bottom.

---

## 1. What CAPEX is

CAPEX is a **Claude Code plugin** (repo: `~/capex-plugin`) that lowers token
spend and latency by **replacing Claude Code's built-in file tools** (Read, Edit,
Write, Grep, Glob, NotebookEdit) with token-efficient MCP tools, exposed through
a dedicated agent (`capex:code`). Everything is **local-only — no login, no
telemetry, no SaaS** (state lives in `~/.capex/`). Privacy is a deliberate
differentiator; do NOT add telemetry.

It is inspired by **Woz** (`WithWoz/wozcode-plugin`, a closed/minified
competitor). Woz's key ideas, which we studied and reimplemented in the open:
- Replace built-in file tools with smarter ones (Search returns content, edits
  batch, etc.).
- An **AST / tree-sitter layer**: symbol outline, find-references, find-
  definition, "enclosing" context.
- A **`Sql`** tool to avoid repeated `sqlite3`/`psql` shell calls.
- A **retroactive savings scanner**: parse real session transcripts and detect
  inefficiency patterns (`grep→read`, `read-batch`, `edit-batch`, `failed-edit`,
  `bash-sql`) that the tools would collapse, then price the saved roundtrips at
  the session's real per-turn cost.
- Woz's flaw we improved on: it *estimates* savings from pattern detection and
  ignores the replacement tool's own output cost. We run real **A/B benchmarks**.

## 2. The single most important thing: the cost model

A tool call's billed cost is roughly:

```
cost ≈ re-billed context (mostly CACHE-READ, ~10% of input price)  +  OUTPUT (5× input price)
```

Implications you must internalize (we proved each one with benchmarks):
1. **Reducing roundtrips alone does NOT save money** if the replacement adds
   output. Our batched `Edit` that echoes 28 `{old,new}` objects *lost* at scale
   because output is 5× input.
2. **The reliable levers minimize OUTPUT and FRESH context**: do work
   server-side and return a tiny summary; return terse/targeted results.
3. **AST-precise beats regex** (no false-positive matches → no wasted reads).
4. **Failed edits are pure waste** (error→reread→retry = 2–4 wasted turns); a
   robust first-try edit is a free win.
5. **"Enumerate the whole repo" tasks are adversarial** — the output is
   inherently large; tools that dump everything lose. Favor *surgical* use.

Good new tricks attack OUTPUT tokens and FRESH context, or eliminate wasted
turns. Rank your ideas by this model before building.

## 3. Current state (what already exists — don't reinvent)

8 MCP tools, all registered in `servers/code-server.js`:
- `Search` (`src/search.js`) — glob + regex, returns matching lines w/ context.
- `Edit` (`src/edit.js`) — batched, whitespace-tolerant, atomic per file.
- `Read` (`src/read.js`) — line ranges + `signatures_only` mode.
- `Write` (`src/write.js`).
- `Outline` (`src/outline.js` + `src/ast.js`) — AST symbol map of a file/glob.
- `Refs` / `Def` (`src/refs.js`) — AST find-references / find-definition.
- `Sql` (`src/sql.js`) — query/introspect SQLite via built-in `node:sqlite`.

AST core: `src/ast.js` uses **`web-tree-sitter@0.22.6`** + grammar wasms from
**`tree-sitter-wasms`** (js/ts/tsx, py, go, rust, java, ruby, c/cpp). NOTE the
pinned version: 0.22.6 — newer web-tree-sitter (0.26) is ABI-incompatible with
those grammars.

Savings accounting (for the live status line, not the benchmark):
- `src/savings-model.js` — `estimateSavings(meta, ctx)`, one `case` per tool mode.
- `src/transcript.js` — reads Claude Code transcripts, **dedupes by
  `message.id`**, prices tokens, computes per-roundtrip cost.
- `scripts/tracking-hook.js` — PostToolUse hook; `deriveMeta()` maps a tool call
  to a savings `meta`; persists to `~/.capex/`.
- `src/paths.js` — `freshState().byTool` lists each tool (keep in sync).

Retroactive scanner: `src/scan.js` + `scripts/savings-scan.js`
(`node scripts/savings-scan.js --days 14`).

Agent definitions: `agents/code.md` (main; lists hard rules nudging tool use)
and `agents/explore.md` (read-only haiku subagent).

Tests: `test/*.test.js` (+ `scripts/smoketest.js`). Run with:
```
cd ~/capex-plugin && node --test "test/**/*.test.js"
```
All currently pass (57). The smoke test asserts the exact sorted tool-name list
— update it when you add a tool.

## 4. How to add a tool (the pattern)

1. `src/<tool>.js`: export `<tool>Schema` (JSON schema) and
   `async function do<Tool>(args) { ... return { text, meta: { mode, ... } }; }`.
2. Register it in `servers/code-server.js` `tools{}` with a crisp description
   (the description is what teaches the model when to use it — make it precise).
3. Add a `case "<mode>"` in `src/savings-model.js`.
4. Add a `case "<Tool>"` in `deriveMeta()` in `scripts/tracking-hook.js`.
5. Add the tool name to `byTool` in `src/paths.js`.
6. Update the sorted tool list assertion in `scripts/smoketest.js`.
7. Add a one-line usage rule to `agents/code.md`.
8. Write `test/<tool>.test.js`.

## 5. How the benchmark / eval works (READ CAREFULLY — it's a real eval)

`bench/run.js` runs each task **twice on identical fresh fixtures**: once
"vanilla" (CAPEX MCP tools denied → stock Claude Code) and once "capex"
(`--agent capex:code --plugin-dir`). Both arms have the **full real toolset**
(Bash, subagents) — this is the realistic product comparison, not a lab test.

Ground truth = each run's `claude -p --output-format json` result. We measure:
- **cost** (from cumulative deduped transcript tokens priced in `transcript.js`;
  `total_cost_usd` kept as a cross-check),
- **fresh tokens** (input + cache-creation + output — the cache-warmth-
  independent work signal),
- **turns**, and **wall-clock time**.

Commands:
```
node bench/run.js                       # default realistic tasks, 1 trial
node bench/run.js --trials 3            # average 3 trials (recommended)
node bench/run.js --tasks feat-currency,add-service
node bench/run.js --isolated           # deny Bash+subagents both arms (tool-isolated)
node bench/make-fixture.js <dir> --modules 30   # generate a fixture by hand
node scripts/savings-scan.js --days 14 # retroactive scan of your real sessions
```
Requirements: the `claude` CLI on PATH, authenticated. **It spends real API
budget** (a few cents to ~$0.50 per run; a full 5-task × 2-trial run is a few $).
Run heavy benchmarks in the background and report.

Tasks live in `bench/tasks.js`. The default set is **realistic multi-step
coding tasks** (`feat-currency`, `bugfix-clamp`, `add-service`, `add-tests`,
`api-docs`) with real `verify()` (runs `node --check` / `node --test` /
behavioral asserts so a cheap run that didn't actually do the work is flagged ✗).
Add a task: append to `tasks.js` (fields: `id`, `modules`, `maxTurns`, `prompt`,
and `verify(dir)` or `expectMentions`). Make verification robust and lenient
about naming.

### Measurement gotchas (these bit us; respect them)
- **Dedupe transcripts by `message.id`.** Claude Code logs some turns 2–3×
  (streaming/retries). Counting all lines inflates tokens 2–3×. `transcript.js`
  already dedupes — reuse it, don't re-sum raw lines.
- **Sub-agents** write separate transcripts; sum the whole **project dir**, not
  one file (`sumTranscriptDir`). Each run uses a unique temp cwd → unique dir.
- The CLI result's `usage` is **final-turn only** — never use it for cumulative.
- **Cache warmth** swings per-run cost wildly; the harness alternates arm order
  per trial — use **≥2–3 trials** and lead with fresh-tokens + turns + time, not
  a single $ number.

## 6. Where CAPEX stands today (the bar to beat)

Latest deduped real eval (full system, 5 realistic tasks × 2 trials, vanilla vs
beefed CAPEX): **cost −48%, fresh tokens −45%, wall-time −63%**, winning 4/5
tasks. The only loss is `api-docs` ("list every symbol in the repo") where the
output is inherently huge — that's the adversarial case. See `bench/FINDINGS.md`
for the full history and the principles.

Known opportunities (seeds — you should generate your own and more):
- A **server-side `replace(glob, old, new)`** that returns a one-line summary
  (kills the output-token cost of multi-file renames; should beat `sed`).
- **Terser Search by default** (paths + `file:line`; verbose context opt-in).
- **AST enclosing-context** for each Search hit (show the containing signature).
- **Robust/fuzzy Edit hardening** + a benchmark task that induces edit-failure
  retry loops, to prove the failed-edit win.
- **Symbol-scoped Read** (read just one function/class by name via AST).
- **Multi-file batched Read** in one call.
- **Import/dependency graph** tool.
- **Test-runner** tool that returns only failures (not full output).
- Avoid the "dump everything" trap — make structural tools surgical.

---

## YOUR TASK

1. **Think deeply and propose 10 distinct new tricks** to make CAPEX save more
   money/time. For each: state the cost-model mechanism it attacks (output?
   fresh context? wasted turns?), the expected win, and the risk. Rank them.
2. **Implement them one at a time**, following the "add a tool" pattern (or
   modifying an existing tool/agent rule where that's the right move). Keep each
   change isolated and add tests; keep `node --test` green.
3. **Benchmark each** with a fair A/B: add or reuse a realistic task in
   `bench/tasks.js` that actually exercises the trick, run
   `node bench/run.js --tasks <id> --trials 3`, and record cost/tokens/turns/
   time vs vanilla. Use the deduped harness; don't trust a single trial.
4. **Keep or kill based on evidence.** Report honest deltas — including
   regressions. A trick that reduces roundtrips but raises output/cost should be
   reverted or redesigned. Append a results section to `bench/FINDINGS.md`.
5. Be rigorous and skeptical: verify the benchmark is apples-to-apples, watch
   for the measurement gotchas above, and don't overclaim. The goal is *real,
   reproducible* savings on realistic coding tasks, not a bigger headline number.

Deliverables: the implemented tricks (tests green), per-trick benchmark results,
and an updated `bench/FINDINGS.md` with an honest verdict on each.
