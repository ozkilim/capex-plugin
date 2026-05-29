import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doSql } from "../src/sql.js";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capex-sql-"));
  return { dir, file: "data.db" };
}
async function seed(dir, file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dir, file));
  db.exec("CREATE TABLE users(id INTEGER, name TEXT); INSERT INTO users VALUES (1,'Ann'),(2,'Bob')");
  db.close();
}

test("Sql introspects schema when no query given", async () => {
  const { dir, file } = tmpDb();
  await seed(dir, file);
  const r = await doSql({ cwd: dir, db: file });
  assert.strictEqual(r.meta.mode, "sql");
  assert.strictEqual(r.meta.tables, 1);
  assert.match(r.text, /users\(/);
});

test("Sql runs a SELECT and returns rows", async () => {
  const { dir, file } = tmpDb();
  await seed(dir, file);
  const r = await doSql({ cwd: dir, db: file, query: "SELECT name FROM users WHERE id > 0 ORDER BY id" });
  assert.strictEqual(r.meta.rows, 2);
  assert.match(r.text, /Ann/);
  assert.match(r.text, /Bob/);
});

test("Sql rewrites ILIKE/NOW() dialect to SQLite", async () => {
  const { dir, file } = tmpDb();
  await seed(dir, file);
  const r = await doSql({ cwd: dir, db: file, query: "SELECT name FROM users WHERE name ILIKE 'a%'" });
  assert.strictEqual(r.meta.ran, true);
  assert.match(r.text, /Ann/);
});

test("Sql handles a missing database gracefully", async () => {
  const { dir } = tmpDb();
  const r = await doSql({ cwd: dir, db: "nope.db" });
  assert.strictEqual(r.meta.ran, false);
});
