---
name: capex-status
description: Show the current CAPEX session status line.
allowed-tools: Bash(node *)
---
Print the one-line CAPEX status:

```bash
echo '{}' | node ${CLAUDE_PLUGIN_ROOT}/scripts/status-line.js
```

Relay the output to the user.
