// Fire-and-forget: push cumulative lifetime savings to the CAPEX web app.
// Spawned detached by the tracking hook, so it must never block or throw.
import fs from "node:fs";
import { lifetimeFile } from "../src/paths.js";
import { loadAuth, ensureMachine, buildSavingsPayload, DEFAULT_API_URL } from "../src/remote.js";

async function main() {
  const auth = loadAuth();
  if (!auth || !auth.token) return;
  const apiUrl = auth.apiUrl || DEFAULT_API_URL;

  let lifetime = {};
  try {
    lifetime = JSON.parse(fs.readFileSync(lifetimeFile(), "utf8"));
  } catch {
    return;
  }

  const payload = buildSavingsPayload(lifetime, ensureMachine());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(`${apiUrl.replace(/\/$/, "")}/api/telemetry/savings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${auth.token}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch {
    // offline / server down / aborted — savings stay local, retried next call.
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
