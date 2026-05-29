import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { doSearch, searchSchema } from "../src/search.js";
import { doEdit, editSchema } from "../src/edit.js";
import { doRead, readSchema } from "../src/read.js";
import { doWrite, writeSchema } from "../src/write.js";
import { doOutline, outlineSchema } from "../src/outline.js";
import { doRefs, refsSchema, doDef, defSchema } from "../src/refs.js";
import { doSql, sqlSchema } from "../src/sql.js";
import { doReplace, replaceSchema } from "../src/replace.js";
import { doRunTests, runTestsSchema } from "../src/runtests.js";
import { doView, viewSchema } from "../src/view.js";
import { doMap, mapSchema } from "../src/map.js";
import { doImports, importsSchema } from "../src/imports.js";
import { doInsert, insertSchema } from "../src/insert.js";
import { doWhere, whereSchema } from "../src/where.js";
import { doRun, runSchema } from "../src/run.js";

const server = new Server(
  { name: "capex-code", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const tools = {
  Search: {
    description: "Find files matching glob patterns and optionally lines matching a regex, with surrounding context. One call replaces Glob + Grep + multiple Reads.",
    inputSchema: searchSchema,
    handler: doSearch
  },
  Edit: {
    description: "Apply a batch of edits across one or more files. Pass edits:[{file, old_string, new_string, replace_all?}]. Whitespace-tolerant matching; atomic per file. Batch ALL edits for a task into one call.",
    inputSchema: editSchema,
    handler: doEdit
  },
  Read: {
    description: "Read a file with line-number gutters. Supports offset/limit and a signatures_only mode that elides function/class bodies for large files.",
    inputSchema: readSchema,
    handler: doRead
  },
  Write: {
    description: "Write content to a file, creating parent directories. Requires force:true to overwrite an existing file.",
    inputSchema: writeSchema,
    handler: doWrite
  },
  Outline: {
    description: "AST symbol map of a file or glob: exported/defined functions, classes, methods, types with line ranges — WITHOUT reading bodies. Use to understand structure or locate symbols cheaply instead of reading whole files. Multi-language (js/ts/tsx, py, go, rust, java, ruby, c/cpp).",
    inputSchema: outlineSchema,
    handler: doOutline
  },
  Refs: {
    description: "Find every reference / call site of a symbol across a file or glob, AST-precise (no regex false positives). Returns file:line:col + the line. Replaces grep-then-read-each-hit. Multi-language.",
    inputSchema: refsSchema,
    handler: doRefs
  },
  Def: {
    description: "Find where a symbol is DEFINED (declaration + signature + line range) across a file or glob, AST-precise. Use instead of grepping then reading to locate a definition. Multi-language.",
    inputSchema: defSchema,
    handler: doDef
  },
  Sql: {
    description: "Query a SQLite database file or introspect its schema in one call, instead of repeatedly shelling out to sqlite3. Omit `query` to get tables+columns. Light Postgres/MySQL dialect rewriting (ILIKE, NOW(), :: casts).",
    inputSchema: sqlSchema,
    handler: doSql
  },
  Replace: {
    description: "Find/replace a string across many files server-side and return only a one-line summary (counts), never echoing the edits. Use this for renames and repo-wide text changes instead of many Edit calls — it is far cheaper because it does not re-emit the changes as output. Set word_boundary:true to safely rename a symbol everywhere.",
    inputSchema: replaceSchema,
    handler: doReplace
  },
  RunTests: {
    description: "Run the test suite and return ONLY the failures plus a pass/fail count — not the full runner output. Use this instead of running tests via Bash, especially in an edit-test loop, to keep huge passing-test output out of context.",
    inputSchema: runTestsSchema,
    handler: doRunTests
  },
  View: {
    description: "Read exactly one function/class/method by name (AST-located), returning just that symbol's body with line numbers. Use instead of reading a whole file or guessing offset/limit when you only need one symbol.",
    inputSchema: viewSchema,
    handler: doView
  },
  Map: {
    description: "One-call repo skeleton for orientation: every source file with the names of the symbols it defines (no bodies), plus other files listed. Use this FIRST on an unfamiliar repo instead of ls + reading several files — it replaces the whole cold-start exploration in a single terse result.",
    inputSchema: mapSchema,
    handler: doMap
  },
  Imports: {
    description: "Trace dependency edges: which files import a given module (pass `module`), or what a file imports (pass `of_file`). Returns file:line of each import. Use instead of grepping then reading to understand how code is wired.",
    inputSchema: importsSchema,
    handler: doImports
  },
  Insert: {
    description: "Insert code at an AST-anchored position (after_symbol / before_symbol / position:end|top) without quoting surrounding code. Use to add a new function, import, or export — cheaper than Edit (no anchor echoed) and no failed-match retries. Reports whether the file still parses.",
    inputSchema: insertSchema,
    handler: doInsert
  },
  Where: {
    description: "Everything about a symbol in ONE call: its definition (signature + line range) AND all call sites across the repo, AST-precise. Fuses Def + Refs — use when you need to understand and trace a symbol.",
    inputSchema: whereSchema,
    handler: doWhere
  },
  Run: {
    description: "Run a build/lint/typecheck/format command and return ONLY the exit code plus error-relevant lines — never the full output. Use instead of Bash for verification commands to keep large passing output out of context.",
    inputSchema: runSchema,
    handler: doRun
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools[req.params.name];
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  const result = await tool.handler(req.params.arguments || {});
  return {
    content: [{ type: "text", text: result.text }],
    _meta: { capex: result.meta }
  };
});

await server.connect(new StdioServerTransport());
