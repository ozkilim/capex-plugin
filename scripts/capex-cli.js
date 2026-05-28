// CAPEX account link CLI. Usage:
//   node capex-cli.js login --token cpx_sk_... [--url https://app.example.com]
//   node capex-cli.js status
//   node capex-cli.js logout
import { loadAuth, saveAuth, clearAuth, ensureMachine, DEFAULT_API_URL } from "../src/remote.js";

function getFlag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];

if (cmd === "login") {
  const token = getFlag("--token");
  const url = getFlag("--url") || DEFAULT_API_URL;
  if (!token) {
    console.log("No token provided.");
    console.log("Get a token from your CAPEX dashboard (Token / Connect page), then run:");
    console.log("  /capex-login --token <your-token>");
    process.exit(1);
  }
  if (!/^cpx_sk_/.test(token)) {
    console.log("That doesn't look like a CAPEX token (expected cpx_sk_...).");
    process.exit(1);
  }
  const machine = ensureMachine();
  saveAuth({ token, apiUrl: url });
  console.log(`Linked this machine (${machine.label}) to CAPEX at ${url}.`);
  console.log("Savings will sync automatically after each tool call.");
  process.exit(0);
}

if (cmd === "status") {
  const auth = loadAuth();
  if (auth && auth.token) {
    console.log(`Linked to ${auth.apiUrl || DEFAULT_API_URL} (token cpx_sk_…${auth.token.slice(-4)}).`);
  } else {
    console.log("Not linked. Run /capex-login --token <your-token> to connect.");
  }
  process.exit(0);
}

if (cmd === "logout") {
  clearAuth();
  console.log("Unlinked this machine from CAPEX. Local tracking continues.");
  process.exit(0);
}

console.log("Usage: capex-cli.js <login|status|logout> [--token <t>] [--url <u>]");
process.exit(1);
