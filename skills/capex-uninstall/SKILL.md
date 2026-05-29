---
name: capex-uninstall
description: Cleanly remove everything CAPEX added outside the plugin — the self-installed status line, pinned agent, and permission entries. Run this BEFORE `/plugin uninstall`. Pass --purge to also delete lifetime savings state in ~/.capex.
allowed-tools: Bash(node *)
---
Clean up everything CAPEX wrote into the user's Claude Code settings, so nothing
is orphaned after the plugin is removed. This must run while the plugin is still
installed (a hook can't run after uninstall).

Pass through any arguments (e.g. `--purge` to also delete `~/.capex`).

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.js $ARGUMENTS
```

Relay the full output. The script removes the status line / agent / permission
entries automatically, then prints the two `/plugin …` commands the user must
run to remove the plugin itself (a skill cannot do that). Remind the user to
restart Claude Code afterward.
