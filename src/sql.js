// Sql tool: run a query (or introspect schema) against a SQLite database file
// in one call, instead of shelling out to `sqlite3` repeatedly. Uses Node's
// built-in node:sqlite (no external driver). Light Postgres/MySQL-dialect
// rewriting so common cross-dialect queries "just work" (best-effort parity
// with Woz's Sql tool, scoped to SQLite which we can support dependency-free).
import path from "node:path";
import fs from "node:fs";

// Best-effort dialect normalization toward SQLite.
function toSqlite(q) {
  return q
    .replace(/\bILIKE\b/gi, "LIKE")            // SQLite LIKE is case-insensitive for ASCII
    .replace(/\bNOW\s*\(\s*\)/gi, "datetime('now')")
    .replace(/\bTRUE\b/gi, "1")
    .replace(/\bFALSE\b/gi, "0")
    .replace(/(\w+)::(\w+)/g, "CAST($1 AS $2)"); // pg :: casts -> CAST(...)
}

function fmtRows(rows, maxRows) {
  if (!rows.length) return "(0 rows)";
  const capped = rows.length > maxRows;
  const shown = rows.slice(0, maxRows);
  const cols = Object.keys(shown[0]);
  const lines = [cols.join(" | ")];
  for (const r of shown) lines.push(cols.map((c) => String(r[c] ?? "")).join(" | "));
  if (capped) lines.push(`… ${rows.length - maxRows} more row(s)`);
  return lines.join("\n");
}

export const sqlSchema = {
  type: "object",
  required: ["db"],
  properties: {
    db: { type: "string", description: "Path to a SQLite database file (relative to cwd)." },
    query: { type: "string", description: "SQL to run. If omitted, returns the schema (tables + columns)." },
    cwd: { type: "string" },
    max_rows: { type: "number", default: 100 },
  },
};

export async function doSql(args = {}) {
  const cwd = path.resolve(args.cwd || process.cwd());
  const dbPath = path.resolve(cwd, args.db || "");
  const maxRows = args.max_rows ?? 100;

  if (!args.db || !fs.existsSync(dbPath)) {
    return { text: `(database not found: ${args.db})`, meta: { mode: "sql", ran: false } };
  }

  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return { text: "(node:sqlite unavailable — needs Node 22+)", meta: { mode: "sql", ran: false } }; }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: false });

    // No query -> schema introspection (tables + their columns) in one shot.
    if (!args.query || !args.query.trim()) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const blocks = [];
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all();
        blocks.push(`${t.name}(` + cols.map((c) => `${c.name} ${c.type}`).join(", ") + ")");
      }
      const text = blocks.length ? blocks.join("\n") : "(no tables)";
      return { text, meta: { mode: "sql", ran: true, tables: tables.length } };
    }

    const sql = toSqlite(args.query);
    const isSelect = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql);
    if (isSelect) {
      const rows = db.prepare(sql).all();
      return { text: fmtRows(rows, maxRows), meta: { mode: "sql", ran: true, rows: rows.length } };
    }
    const info = db.prepare(sql).run();
    return { text: `OK (${info.changes} row(s) changed)`, meta: { mode: "sql", ran: true, changes: Number(info.changes) } };
  } catch (e) {
    return { text: `SQL error: ${e.message}`, meta: { mode: "sql", ran: false } };
  } finally {
    try { db && db.close(); } catch {}
  }
}
