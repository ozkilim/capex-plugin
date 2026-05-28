---
name: capex-savings
description: Show the CAPEX savings report — estimated dollars, tokens, time, and roundtrips saved this session and lifetime.
allowed-tools: Bash(node *)
---
Run the CAPEX savings report. Pass through the current Claude Code session id if available.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/savings-report.js
```

Relay the full output to the user. Do not summarize or paraphrase.
