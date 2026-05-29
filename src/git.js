// Git: token-efficient wrappers around the git commands an agent runs most
// (status / diff / log / add / commit / push / pull / branch). Run via plain
// Bash, these emit large, repetitive output that lands in context and is then
// re-billed as cache-read on every later turn — `git status` help text, full
// diff hunks, multi-line log entries. This returns the compact essence:
//   - status  -> branch + ahead/behind + grouped, one-line-per-file changes
//   - diff     -> per-file +adds/-dels summary (full hunks only on request)
//   - log      -> one line per commit
//   - add/commit/push/pull -> "ok …" or just the error tail
//
// Safety: git is invoked with an argv array and shell:false, so commit messages
// and paths can't inject shell. Only an allow-listed set of subcommands runs.
import { spawnSync } from "node:child_process";
import path from "node:path";

export const gitSchema = {
  type: "object",
  required: ["op"],
  properties: {
    op: {
      type: "string",
      enum: ["status", "diff", "log", "add", "commit", "push", "pull", "branch"],
      description: "Git operation to run.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Extra arguments (e.g. paths for add/diff, or flags). Passed verbatim, never through a shell.",
    },
    message: { type: "string", description: "Commit message (op=commit)." },
    cached: { type: "boolean", description: "op=diff: show the staged diff (--cached)." },
    full: { type: "boolean", description: "op=diff: include full hunks (capped) instead of just per-file +/- counts." },
    n: { type: "number", description: "op=log: number of commits (default 15)." },
    cwd: { type: "string" },
  },
};

const MAX_DIFF_FILES = 60;
const MAX_DIFF_HUNK_LINES = 120;
const MAX_LOG = 50;

function runGit(cwd, argv) {
  const r = spawnSync("git", argv, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return {
    status: r.status ?? (r.error ? 127 : 0),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error,
  };
}

function tail(s, n) {
  return s.split("\n").filter(Boolean).slice(-n).join("\n");
}

const git = (mode, op, text, extra = {}) => ({ text, meta: { mode, op, ...extra } });

// XY porcelain code -> human group. We only need a coarse bucket per file.
function statusGroup(x, y) {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) return "conflicted";
  const staged = x !== " " && x !== "?";
  const unstaged = y !== " " && y !== "?";
  if (staged && unstaged) return "staged+unstaged";
  if (staged) return "staged";
  return "unstaged";
}

function doStatus(cwd) {
  const r = runGit(cwd, ["status", "--porcelain=v1", "-b"]);
  if (r.status !== 0) return git("git", "status", `✗ git status failed:\n${tail(r.stderr || r.stdout, 10)}`, { ok: false });

  const lines = r.stdout.split("\n").filter(Boolean);
  let branch = "";
  const files = [];
  for (const l of lines) {
    if (l.startsWith("##")) {
      // "## main...origin/main [ahead 1, behind 2]" -> keep the informative bits.
      branch = l.slice(2).trim().replace(/\.\.\.\S+/, (m) => m); // keep upstream
      continue;
    }
    const x = l[0], y = l[1];
    files.push({ x, y, group: statusGroup(x, y), path: l.slice(3) });
  }

  if (!files.length) {
    return git("git", "status", `branch ${branch || "?"} — clean`, { ok: true, linesSuppressed: 6 });
  }

  // Group counts + a capped, one-line-per-file list.
  const order = ["conflicted", "staged+unstaged", "staged", "unstaged", "untracked"];
  const byGroup = {};
  for (const f of files) (byGroup[f.group] ||= []).push(f);

  const head = `branch ${branch || "?"} — ${files.length} changed`;
  const out = [head];
  for (const g of order) {
    const arr = byGroup[g];
    if (!arr || !arr.length) continue;
    out.push(`${g} (${arr.length}):`);
    for (const f of arr.slice(0, MAX_DIFF_FILES)) out.push(`  ${f.x}${f.y} ${f.path}`);
    if (arr.length > MAX_DIFF_FILES) out.push(`  … ${arr.length - MAX_DIFF_FILES} more`);
  }
  // Verbose `git status` adds ~2 boilerplate/help lines per section plus headers.
  const linesSuppressed = files.length + order.length * 2 + 4;
  return git("git", "status", out.join("\n"), { ok: true, files: files.length, linesSuppressed });
}

function doDiff(cwd, { args = [], cached, full }) {
  const base = ["diff"];
  if (cached) base.push("--cached");

  // numstat is tiny and gives us per-file +/-, which is also a clean proxy for
  // how many hunk lines we're choosing NOT to return.
  const ns = runGit(cwd, [...base, "--numstat", "--", ...args]);
  if (ns.status !== 0) return git("git", "diff", `✗ git diff failed:\n${tail(ns.stderr || ns.stdout, 10)}`, { ok: false });

  const rows = ns.stdout.split("\n").filter(Boolean).map((l) => {
    const m = l.match(/^(\S+)\t(\S+)\t(.+)$/);
    if (!m) return null;
    const added = m[1] === "-" ? 0 : Number(m[1]); // "-" for binary files
    const deleted = m[2] === "-" ? 0 : Number(m[2]);
    return { added, deleted, path: m[3], binary: m[1] === "-" };
  }).filter(Boolean);

  if (!rows.length) return git("git", "diff", cached ? "no staged changes" : "no unstaged changes", { ok: true, linesSuppressed: 0 });

  const totalAdd = rows.reduce((s, r) => s + r.added, 0);
  const totalDel = rows.reduce((s, r) => s + r.deleted, 0);
  const hunkLines = totalAdd + totalDel;

  const summary = [`${rows.length} file(s) changed, +${totalAdd} -${totalDel}`];
  for (const r of rows.slice(0, MAX_DIFF_FILES)) {
    summary.push(r.binary ? `  (bin) ${r.path}` : `  +${r.added} -${r.deleted} ${r.path}`);
  }
  if (rows.length > MAX_DIFF_FILES) summary.push(`  … ${rows.length - MAX_DIFF_FILES} more file(s)`);

  if (!full) {
    // Summary-only: the hunk body (hunkLines) is what we avoided putting in context.
    return git("git", "diff", summary.join("\n"), { ok: true, files: rows.length, linesSuppressed: hunkLines });
  }

  // full: include the hunks, but capped so a huge diff can't blow up context.
  const fullDiff = runGit(cwd, [...base, "--", ...args]);
  const dl = fullDiff.stdout.split("\n");
  const capped = dl.slice(0, MAX_DIFF_HUNK_LINES);
  const note = dl.length > MAX_DIFF_HUNK_LINES ? `\n… (${dl.length - MAX_DIFF_HUNK_LINES} more diff lines; call without full or narrow with args:[path])` : "";
  const suppressed = Math.max(0, dl.length - capped.length);
  return git("git", "diff", `${summary[0]}\n${capped.join("\n")}${note}`, { ok: true, files: rows.length, linesSuppressed: suppressed });
}

function doLog(cwd, { n = 15, args = [] }) {
  const count = Math.max(1, Math.min(MAX_LOG, n || 15));
  const r = runGit(cwd, ["log", `-n${count}`, "--pretty=format:%h %s", ...args]);
  if (r.status !== 0) return git("git", "log", `✗ git log failed:\n${tail(r.stderr || r.stdout, 10)}`, { ok: false });
  const entries = r.stdout.split("\n").filter(Boolean);
  // A default `git log` prints ~6 lines per commit (hash/author/date/blank/msg);
  // one-line format suppresses ~5 per commit.
  return git("git", "log", entries.join("\n"), { ok: true, count: entries.length, linesSuppressed: entries.length * 5 });
}

function doAdd(cwd, { args = [] }) {
  if (!args.length) return git("git", "add", "Provide paths in `args` (e.g. args:[\"src/foo.js\"]).", { ok: false });
  const r = runGit(cwd, ["add", "--", ...args]);
  if (r.status !== 0) return git("git", "add", `✗ git add failed:\n${tail(r.stderr || r.stdout, 8)}`, { ok: false });
  return git("git", "add", `ok — staged ${args.length} path(s)`, { ok: true, linesSuppressed: 0 });
}

function doCommit(cwd, { message, args = [] }) {
  if (!message) return git("git", "commit", "Provide a `message`.", { ok: false });
  const r = runGit(cwd, ["commit", "-m", message, ...args]);
  if (r.status !== 0) {
    // e.g. "nothing to commit" or a failing hook — return the short reason only.
    return git("git", "commit", `✗ git commit failed:\n${tail(r.stderr || r.stdout, 12)}`, { ok: false });
  }
  // Output looks like "[main abc1234] subject" or, for the first commit,
  // "[main (root-commit) abc1234] subject" — so pull the sha as the last hex
  // token inside the brackets and the branch as the first token.
  const bm = r.stdout.match(/\[([^\]]+)\]\s*(.*)/);
  let text = "ok — committed";
  if (bm) {
    const inside = bm[1];
    const shaM = inside.match(/([0-9a-f]{7,40})\b/);
    const branch = inside.split(/\s+/)[0];
    text = `ok ${shaM ? shaM[1] : ""} (${branch}) — ${bm[2] || message}`.replace("  ", " ");
  }
  // git's commit output (files changed, create mode lines) is suppressed.
  const suppressed = Math.max(0, r.stdout.split("\n").filter(Boolean).length - 1);
  return git("git", "commit", text, { ok: true, linesSuppressed: suppressed });
}

function doPush(cwd, { args = [] }) {
  const r = runGit(cwd, ["push", ...args]);
  const out = (r.stdout + "\n" + r.stderr).split("\n").filter(Boolean);
  if (r.status !== 0) return git("git", "push", `✗ git push failed:\n${tail(r.stdout + "\n" + r.stderr, 12)}`, { ok: false });
  // Success: keep the one informative line (the ref update / "up-to-date").
  const info = out.find((l) => /->|up-to-date|up to date/.test(l)) || out[out.length - 1] || "ok";
  return git("git", "push", `ok — ${info.trim()}`, { ok: true, linesSuppressed: Math.max(0, out.length - 1) });
}

function doPull(cwd, { args = [] }) {
  const r = runGit(cwd, ["pull", ...args]);
  if (r.status !== 0) return git("git", "pull", `✗ git pull failed:\n${tail(r.stdout + "\n" + r.stderr, 12)}`, { ok: false });
  const out = (r.stdout + "\n" + r.stderr).split("\n").filter(Boolean);
  // Keep the summary lines (Updating/Fast-forward/Already up to date + diffstat total).
  const keep = out.filter((l) => /Updating|Fast-forward|Already up to date|files? changed|insertion|deletion/.test(l));
  const text = keep.length ? keep.join("\n") : tail(out.join("\n"), 4);
  return git("git", "pull", text, { ok: true, linesSuppressed: Math.max(0, out.length - keep.length) });
}

function doBranch(cwd, { args = [] }) {
  // No args -> current branch only (the common, tiny query).
  if (!args.length) {
    const r = runGit(cwd, ["branch", "--show-current"]);
    if (r.status !== 0) return git("git", "branch", `✗ git branch failed:\n${tail(r.stderr, 6)}`, { ok: false });
    return git("git", "branch", (r.stdout.trim() || "(detached)"), { ok: true, linesSuppressed: 0 });
  }
  const r = runGit(cwd, ["branch", ...args]);
  if (r.status !== 0) return git("git", "branch", `✗ git branch failed:\n${tail(r.stderr, 8)}`, { ok: false });
  return git("git", "branch", r.stdout.trim() || "ok", { ok: true, linesSuppressed: 0 });
}

export async function doGit(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const op = args.op;
  switch (op) {
    case "status": return doStatus(cwd);
    case "diff": return doDiff(cwd, args);
    case "log": return doLog(cwd, args);
    case "add": return doAdd(cwd, args);
    case "commit": return doCommit(cwd, args);
    case "push": return doPush(cwd, args);
    case "pull": return doPull(cwd, args);
    case "branch": return doBranch(cwd, args);
    default:
      return git("git", op || "?", `Unknown op. Use one of: status, diff, log, add, commit, push, pull, branch.`, { ok: false });
  }
}
