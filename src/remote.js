import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { capexDir, ensureCapexDir } from "./paths.js";

export const DEFAULT_API_URL = process.env.CAPEX_API_URL || "https://capex-ten.vercel.app";

export function authFile() {
  return path.join(capexDir(), "auth.json");
}

export function machineFile() {
  return path.join(capexDir(), "machine.json");
}

function atomicWrite(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(authFile(), "utf8"));
  } catch {
    return null;
  }
}

export function saveAuth(auth) {
  ensureCapexDir();
  atomicWrite(authFile(), auth);
}

export function clearAuth() {
  try { fs.unlinkSync(authFile()); } catch {}
}

// Stable per-machine identity so multi-machine savings don't clobber each
// other server-side.
export function ensureMachine() {
  ensureCapexDir();
  try {
    return JSON.parse(fs.readFileSync(machineFile(), "utf8"));
  } catch {
    const machine = { machineId: crypto.randomUUID(), label: os.hostname() };
    atomicWrite(machineFile(), machine);
    return machine;
  }
}

export function buildSavingsPayload(lifetime, machine) {
  const l = lifetime || {};
  return {
    machineId: machine.machineId,
    machineLabel: machine.label,
    tokensSaved: l.tokensSaved || 0,
    usdSaved: l.usdSaved || 0,
    roundtripsSaved: l.roundtripsSaved || 0,
    msSaved: l.msSaved || 0,
    toolCalls: l.toolCalls || 0,
    byTool: l.byTool || {}
  };
}
