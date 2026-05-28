import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { doSearch, searchSchema } from "../src/search.js";
import { doEdit, editSchema } from "../src/edit.js";
import { doRead, readSchema } from "../src/read.js";
import { doWrite, writeSchema } from "../src/write.js";

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
