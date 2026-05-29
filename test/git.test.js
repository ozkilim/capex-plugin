import { test, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { doGit } from "../src/git.js";

let dir;
const g = (d, ...argv) => spawnSync("git", argv, { cwd: d, encoding: "utf8" });

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-git-"));
  g(dir, "init", "-q");
  g(dir, "config", "user.email", "t@example.com");
  g(dir, "config", "user.name", "Test");
  g(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("Git status groups files and reports a count", async () => {
  const r = await doGit({ op: "status", cwd: dir });
  assert.strictEqual(r.meta.mode, "git");
  assert.strictEqual(r.meta.op, "status");
  assert.match(r.text, /untracked/);
  assert.match(r.text, /a\.txt/);
  assert.strictEqual(r.meta.files, 1);
});

test("Git add then commit returns ok + sha, not verbose output", async () => {
  const add = await doGit({ op: "add", cwd: dir, args: ["a.txt"] });
  assert.strictEqual(add.meta.ok, true);

  const c = await doGit({ op: "commit", cwd: dir, message: "first commit" });
  assert.strictEqual(c.meta.ok, true);
  assert.match(c.text, /^ok [0-9a-f]{7,}/);
  assert.match(c.text, /first commit/);
  // Must NOT carry git's "create mode"/"files changed" chatter.
  assert.ok(!c.text.includes("create mode"));
});

test("Git diff returns a per-file +/- summary, not full hunks", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
  const d = await doGit({ op: "diff", cwd: dir });
  assert.strictEqual(d.meta.ok, true);
  assert.match(d.text, /1 file\(s\) changed/);
  assert.match(d.text, /a\.txt/);
  // linesSuppressed should reflect the changed hunk lines we omitted.
  assert.ok(d.meta.linesSuppressed >= 1, "credits suppressed hunk lines");
  // Summary mode must not include raw hunk markers.
  assert.ok(!d.text.includes("@@"));
});

test("Git diff full includes hunks", async () => {
  const d = await doGit({ op: "diff", cwd: dir, full: true });
  assert.match(d.text, /@@|TWO|four/);
});

test("Git log is one line per commit", async () => {
  // second commit so there are two entries
  await doGit({ op: "add", cwd: dir, args: ["a.txt"] });
  await doGit({ op: "commit", cwd: dir, message: "second commit" });
  const l = await doGit({ op: "log", cwd: dir, n: 5 });
  const lines = l.text.split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.every((x) => /^[0-9a-f]{7,}\s/.test(x)), "each line starts with a short hash");
  assert.strictEqual(l.meta.count, 2);
});

test("Git branch reports the current branch", async () => {
  const b = await doGit({ op: "branch", cwd: dir });
  assert.strictEqual(b.meta.ok, true);
  assert.ok(b.text.length > 0);
});

test("Git commit with nothing staged fails compactly", async () => {
  const c = await doGit({ op: "commit", cwd: dir, message: "noop" });
  assert.strictEqual(c.meta.ok, false);
  assert.match(c.text, /✗ git commit failed/);
  assert.ok(c.text.split("\n").length <= 13, "stays compact on failure");
});

test("unknown op is rejected", async () => {
  const r = await doGit({ op: "rebase", cwd: dir });
  assert.strictEqual(r.meta.ok, false);
  assert.match(r.text, /Unknown op/);
});
