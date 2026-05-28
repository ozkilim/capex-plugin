---
name: capex-login
description: Link this machine to your CAPEX web account so local savings sync to your online dashboard. Pass --token <token> from the CAPEX dashboard.
allowed-tools: Bash(node *)
---
Link Claude Code to the user's CAPEX web account.

If the user provided a token as an argument (e.g. `--token cpx_sk_...`), run it directly. Otherwise tell them to get a token from the CAPEX dashboard's "Token / Connect" page and re-run with `--token <token>`.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/capex-cli.js login $ARGUMENTS
```

Relay the output. If login succeeded, confirm the machine is linked and that savings will sync automatically.
