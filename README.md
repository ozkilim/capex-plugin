# CAPEX

CAPEX is a free Claude Code plugin that lowers your token spend. It replaces Claude Code's built-in file tools (Read, Edit, Write, Grep, Glob, NotebookEdit) with token-efficient alternatives and adds AST-aware navigation, compact test/build runners, and a compact `git` — then shows your estimated savings live in the status line.

The wins come from two levers: **fewer roundtrips** (one `Search` replaces Glob + Grep + several Reads; one batched `Edit` applies many changes at once) and **smaller context** (return a symbol's signature instead of a whole file; return only failing tests, not a runner's full output).

No login, no SaaS backend, no telemetry leaves your machine — all state lives in `~/.capex/`.

## Install

Inside a Claude Code session, run:

```
/plugin marketplace add ozkilim/capex-plugin
/plugin install capex@capex-marketplace
```

Then **restart Claude Code**. The `capex:code` agent is now active and the CAPEX tools are available.

That's the whole install — there is **no `npm install` step**. Dependencies are vendored into the repo and are all pure-JS or portable wasm (no native binaries), so the plugin works the moment it's cloned, identically on macOS, Linux, and Windows.

## Tools

All tools are exposed as `mcp__plugin_capex_code__<Name>`. The `capex:code` agent prefers them over the built-ins.

**Explore & navigate**
- `Map` — one-call repo skeleton: every source file with the symbols it defines (no bodies). Use first on an unfamiliar repo.
- `Search` — glob + regex + context in one call; replaces Glob + Grep + reads.
- `Outline` — AST symbol outline for one or more files, no bodies.
- `Where` — a symbol's definition **and** all call sites across the repo, in one call (fuses Def + Refs).
- `Refs` / `Def` — AST-precise references / definitions of a symbol.
- `Imports` — dependency edges: who imports a module, or what a file imports.

**Read**
- `Read` — file read with line numbers; `signatures_only` mode elides bodies for large files.
- `View` — read exactly one function/class/method by name (AST-located), not the whole file.

**Edit**
- `Edit` — batch many edits across files in one atomic, whitespace-tolerant call.
- `Replace` — server-side multi-file find/replace; returns a tiny summary instead of re-emitting edits.
- `Insert` — add code at an AST-anchored position (after/before a symbol) without quoting surrounding code.
- `Write` — create or overwrite a file.

**Run & inspect**
- `RunTests` — run tests and return only failures + a pass/fail count. Supports Node (`node --test`), pytest, jest, and vitest.
- `Run` — run a build/lint/typecheck command and return only the exit code + error lines.
- `Git` — compact git: `status` / `diff` / `log` / `add` / `commit` / `push` / `pull` / `branch`. Returns the essence (grouped status, per-file `+/-` diff, one-line log, `ok <sha>`) instead of git's verbose output.
- `Sql` — query a SQLite database directly instead of shelling out.

## Status line

**The status line installs itself — no manual setup.** On every session start, CAPEX's `SessionStart` hook writes the status-line command into `~/.claude/settings.json`, pointing at the current install. So after install + restart the savings indicator just appears, and it survives reinstalls and version bumps (the hook refreshes the path to the live install).

It is idempotent and respectful: it adds a status line only if you have none, refreshes its own (even at a stale path), and **never touches a custom status line of yours**.

```
💰 CAPEX est. session savings: $0.12 · 4.2k tokens · 3.4s · 7 roundtrips
```

To opt out, set your own `statusLine` (CAPEX won't overwrite it) or uninstall. Because a hook can't run after uninstall, run `/capex-uninstall` *before* removing the plugin (see [Uninstall](#uninstall)).

## Commands

- `/capex-savings` — full report of estimated dollars, tokens, time, and roundtrips saved this session and lifetime.
- `/capex-status` — the one-line status string.
- `/capex-login --token <token>` — link this machine to your CAPEX web dashboard so savings sync (optional).
- `/capex-uninstall` — remove everything CAPEX wrote to your settings; run before `/plugin uninstall`.

## Verify it's working

After install + restart:

1. **Agent active** — the session uses `capex:code` (built-in Read/Edit/Write/Grep/Glob are blocked).
2. **Search is used** — ask *"Find every place in this repo that imports `fs`."* The call shows as `mcp__plugin_capex_code__Search`.
3. **Edits batch** — ask *"Rename `foo` to `bar` in files `a.ts` and `b.ts`."* You get a single `Edit` call with an `edits` array of length 2.
4. **Savings tracked** — run `/capex-savings` and watch the status line update after the next tool call.

For offline development, `npm test` runs the unit suite plus a standalone MCP server smoke test (`scripts/smoketest.js`).

## How savings are estimated

The numbers are **heuristic estimates**, not measured billing — every figure is labeled "est." The model lives in [`src/savings-model.js`](src/savings-model.js) and is transcript-grounded:

- A saved roundtrip is priced at **this session's real average per-turn token cost**, read from the live transcript — not a flat constant. Before any turn exists it falls back to `FALLBACK_ROUNDTRIP_TOKENS`.
- Per-tool crediting is deliberately conservative: a batched `Edit` saves one roundtrip per edit beyond the first; a multi-file `Replace` ~one per file; a `Search` one roundtrip only when it matches; `signatures_only` Read / `View` / `Outline` save context size (the elided lines never enter context); `RunTests` / `Run` / `Git` credit the re-billed output they suppress.
- Dollar figures use the Sonnet input price (`$3.00 / Mtok`).

Treat the result as a directional indicator of effort saved, not an invoice. To tune, edit the constants at the top of [`src/savings-model.js`](src/savings-model.js): `PRICE_INPUT_PER_MTOK`, `PRICE_OUTPUT_PER_MTOK`, and `FALLBACK_ROUNDTRIP_TOKENS`.

## macOS nvm fix (read this if hooks fail)

If you use nvm to manage Node on macOS, plugin hooks and the MCP server may fail with `node: command not found`, because Claude Code spawns them with a minimal `PATH`. Symlink your Node binary into a standard location (no `sudo` needed on most macOS installs):

```bash
ln -s "$(which node)" /usr/local/bin/node
```

## Uninstall

Run the cleanup command **first, while the plugin is still installed** (a hook can't run after uninstall, so the self-installed status line must be removed beforehand):

```
/capex-uninstall
```

This removes everything CAPEX wrote outside its own dir — the status line, a pinned `"agent": "capex:code"`, and CAPEX permission entries — while leaving any custom status line of yours untouched. It keeps your lifetime savings in `~/.capex`; pass `--purge` (`/capex-uninstall --purge`) to delete those too.

Then remove the plugin itself and restart Claude Code:

```
/plugin uninstall capex@capex-marketplace
/plugin marketplace remove capex-marketplace
```

## License

MIT — see [LICENSE](LICENSE).
