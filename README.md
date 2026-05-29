# CAPEX

CAPEX is a Claude Code plugin that lowers your token spend by replacing Claude Code's built-in file tools (Read, Edit, Write, Grep, Glob, NotebookEdit) with token-efficient alternatives, then shows your estimated savings live in the status line. One smart `Search` call replaces a Glob + Grep + several Reads; one batched `Edit` call applies many changes across files at once. No login, no SaaS backend, no telemetry leaves your machine — all state lives in `~/.capex/`.

## Install

Inside a Claude Code session, run:

```
/plugin marketplace add <YOUR_GITHUB_USERNAME>/capex-plugin
/plugin install capex@capex-marketplace
```

Then **restart Claude Code**. After restart the `capex:code` agent is active and the CAPEX MCP tools are available.

That's the whole install. There is **no `npm install` step** — dependencies are vendored into the repo, so the plugin works the moment it's cloned. All deps are pure-JS or portable wasm (no native binaries), so it works the same on macOS, Linux, and Windows.

## macOS nvm fix (read this if hooks fail)

If you use nvm to manage Node on macOS, plugin hooks and the MCP server may fail with `node: command not found`, because Claude Code spawns them with a minimal `PATH`. Fix it by symlinking your Node binary into a standard location:

```bash
ln -s "$(which node)" /usr/local/bin/node
```

No `sudo` is needed on most macOS installs.

## Status line setup

CAPEX does not auto-install the status line (by design). Add this to your `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/plugins/marketplaces/capex-marketplace/capex/scripts/status-line.js"
  }
}
```

Verify the path after installing by inspecting `~/.claude/plugins/` — the exact directory is created by Claude Code's plugin system when you install. The status line shows, for example:

```
💰 CAPEX est. session savings: $0.12 · 4.2k tokens · 3.4s · 7 roundtrips
```

## Verify

After install + restart, confirm CAPEX is working:

1. **Agent active** — the session uses the `capex:code` agent (built-in Read/Edit/Write/Grep/Glob are blocked).
2. **Search is used** — ask: *"Find every place in this repo that imports `fs`."* In the tool-call stream the call shows as `mcp__plugin_capex_code__Search`, not Glob/Grep/Read.
3. **Edits are batched** — ask: *"Rename the function `foo` to `bar` in files `a.ts` and `b.ts`."* You should see a single `mcp__plugin_capex_code__Edit` call with an `edits` array of length 2.
4. **Savings tracked** — run `/capex-savings` and confirm non-zero numbers, and watch the status line update after the next tool call.

## Commands

- `/capex-savings` — multi-line report of estimated dollars, tokens, time, and roundtrips saved this session and lifetime.
- `/capex-status` — the one-line status string.

## How savings are estimated

The numbers are **heuristic estimates**, not measured token counts — every figure is labeled "est." The model lives in [`src/savings-model.js`](src/savings-model.js):

- A `Search` call is assumed to replace ~3 vanilla roundtrips (Glob + Grep + reads), plus a per-matched-file read estimate (capped at 5 files).
- A batched `Edit` saves one roundtrip per edit beyond the first.
- A `signatures_only` Read is assumed to save ~70% of the file's token cost.
- Dollar figures use the Sonnet input price (`$3.00 / Mtok`).

These are deliberately simple constants. They will not match your real billing exactly — treat them as a directional indicator of effort saved, not an invoice.

## Tuning

Edit the constants at the top of [`src/savings-model.js`](src/savings-model.js):

- `PRICE_INPUT_PER_MTOK` / `PRICE_OUTPUT_PER_MTOK` — baseline model pricing.
- `VANILLA_PER_ROUNDTRIP_TOKENS` — assumed cost of an extra tool-call roundtrip.
- `VANILLA_PER_FILE_READ_TOKENS` — assumed size of an average file read.

## Manual integration test

Claude Code itself can't be scripted in CI, so verify the full loop by hand:

1. Run the two install commands inside a real Claude Code session, then restart.
2. Ask: *"Find every place in this repo that imports `fs`."* Confirm the call shows as `mcp__plugin_capex_code__Search`.
3. Ask: *"Rename the function `foo` to `bar` in files `a.ts` and `b.ts`."* Confirm a single `mcp__plugin_capex_code__Edit` call with `edits.length === 2`.
4. Run `/capex-savings`. Confirm non-zero numbers.
5. Inspect the status line. Confirm it updates after the next tool use.

For offline development, `npm test` runs the unit suite plus a standalone MCP server smoke test (`scripts/smoketest.js`) — the closest you can get to integration testing without Claude Code.

## Uninstall

```
/plugin uninstall capex@capex-marketplace
```

Then remove local state:

```bash
rm -rf ~/.capex
```

## License

MIT — see [LICENSE](LICENSE).
