// Run: execute a build/lint/typecheck/format command and return ONLY the exit
// code plus the error-relevant tail — never the full stdout. Generalizes the
// RunTests idea to any verification command. A passing `tsc`/`eslint`/`build`
// can emit hundreds of lines that, run via Bash, all land in context and get
// re-billed every later turn. Run collapses a clean pass to one line and a
// failure to just the diagnostic lines.
import { spawnSync } from "node:child_process";
import path from "node:path";

export const runSchema = {
  type: "object",
  required: ["command"],
  properties: {
    command: { type: "string", description: "Shell command to run (e.g. 'npm run build', 'tsc --noEmit', 'eslint src')." },
    cwd: { type: "string" },
    max_lines: { type: "number", default: 40, description: "Max output lines to return on failure." },
  },
};

// Heuristic: keep lines that look like diagnostics (errors/warnings/file:line).
const DIAG = /(error|warning|fail|✗|✖|cannot|unexpected|not found|exception|\bat\s+\S+:\d+|^\S+:\d+:\d+)/i;

export async function doRun(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const command = args.command;
  const maxLines = args.max_lines ?? 40;
  if (!command) return { text: "Provide a `command`.", meta: { mode: "run", exit: null } };

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(command, { cwd, env, encoding: "utf8", shell: true, maxBuffer: 32 * 1024 * 1024 });
  const exit = r.status ?? (r.error ? 127 : 0);
  const out = ((r.stdout || "") + "\n" + (r.stderr || "")).split("\n");

  if (exit === 0) {
    return { text: `✓ \`${command}\` exited 0 (output suppressed: ${out.filter(Boolean).length} lines).`, meta: { mode: "run", exit: 0 } };
  }

  // Failure: return diagnostic lines, else the tail.
  let picked = out.filter((l) => DIAG.test(l));
  if (!picked.length) picked = out.filter(Boolean).slice(-maxLines);
  if (picked.length > maxLines) picked = picked.slice(0, maxLines).concat(`… (${picked.length - maxLines} more diagnostic lines)`);
  return {
    text: `✗ \`${command}\` exited ${exit}:\n${picked.join("\n")}`,
    meta: { mode: "run", exit },
  };
}
