// AST code-intelligence core for CAPEX, built on tree-sitter (web-tree-sitter
// runtime + prebuilt grammar wasms from tree-sitter-wasms).
//
// Why: returning an AST-accurate symbol OUTLINE (and later references/defs) lets
// the agent understand a file's structure or find a symbol WITHOUT reading whole
// files — the reliable cost lever (return minimal, structurally-correct context).
//
// Languages are loaded lazily and cached; parsing a file you don't ask about
// costs nothing. Unknown extensions return null so callers can fall back.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import TS from "web-tree-sitter";

const Parser = TS.default || TS;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GRAMMAR_DIR = path.join(PLUGIN_ROOT, "node_modules", "tree-sitter-wasms", "out");

// file extension -> { grammar wasm name, tree-sitter query capturing symbols }.
// Capture name == symbol kind. Each name node's nearest declaration ancestor is
// used for the signature line + line range.
const LANGS = {
  javascript: {
    exts: [".js", ".jsx", ".mjs", ".cjs"],
    query: `
      (function_declaration name:(identifier) @function)
      (class_declaration name:(_) @class)
      (method_definition name:(property_identifier) @method)
      (variable_declarator name:(identifier) @function value:[(arrow_function)(function_expression)])`,
  },
  typescript: {
    exts: [".ts"],
    query: `
      (function_declaration name:(identifier) @function)
      (class_declaration name:(type_identifier) @class)
      (method_definition name:(property_identifier) @method)
      (interface_declaration name:(type_identifier) @interface)
      (type_alias_declaration name:(type_identifier) @type)
      (enum_declaration name:(identifier) @enum)
      (variable_declarator name:(identifier) @function value:[(arrow_function)(function_expression)])`,
  },
  tsx: {
    exts: [".tsx"],
    query: `
      (function_declaration name:(identifier) @function)
      (class_declaration name:(type_identifier) @class)
      (method_definition name:(property_identifier) @method)
      (interface_declaration name:(type_identifier) @interface)
      (type_alias_declaration name:(type_identifier) @type)
      (variable_declarator name:(identifier) @function value:[(arrow_function)(function_expression)])`,
  },
  python: {
    exts: [".py"],
    query: `
      (function_definition name:(identifier) @function)
      (class_definition name:(identifier) @class)`,
  },
  go: {
    exts: [".go"],
    query: `
      (function_declaration name:(identifier) @function)
      (method_declaration name:(field_identifier) @method)
      (type_declaration (type_spec name:(type_identifier) @type))`,
  },
  rust: {
    exts: [".rs"],
    query: `
      (function_item name:(identifier) @function)
      (struct_item name:(type_identifier) @struct)
      (enum_item name:(type_identifier) @enum)
      (trait_item name:(type_identifier) @trait)`,
  },
  java: {
    exts: [".java"],
    query: `
      (class_declaration name:(identifier) @class)
      (interface_declaration name:(identifier) @interface)
      (method_declaration name:(identifier) @method)`,
  },
  ruby: {
    exts: [".rb"],
    query: `
      (method name:(identifier) @method)
      (class name:(constant) @class)
      (module name:(constant) @module)`,
  },
  c: {
    exts: [".c", ".h"],
    query: `(function_definition declarator:(function_declarator declarator:(identifier) @function))`,
  },
  cpp: {
    exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
    query: `
      (function_definition declarator:(function_declarator declarator:(identifier) @function))
      (class_specifier name:(type_identifier) @class)
      (struct_specifier name:(type_identifier) @struct)`,
  },
};

const EXT_TO_LANG = {};
for (const [name, def] of Object.entries(LANGS)) for (const e of def.exts) EXT_TO_LANG[e] = name;

let _initPromise = null;
const _langCache = new Map(); // name -> { language, query }

async function ensureInit() {
  if (!_initPromise) _initPromise = Parser.init();
  await _initPromise;
}

async function loadLang(name) {
  if (_langCache.has(name)) return _langCache.get(name);
  await ensureInit();
  const wasm = path.join(GRAMMAR_DIR, `tree-sitter-${name}.wasm`);
  const language = await Parser.Language.load(wasm);
  let query = null;
  try { query = language.query(LANGS[name].query); } catch { query = null; }
  const entry = { language, query };
  _langCache.set(name, entry);
  return entry;
}

export function langForFile(file) {
  return EXT_TO_LANG[path.extname(file).toLowerCase()] || null;
}

// Walk up to the nearest declaration/definition node for signature + range.
function declAncestor(node) {
  let n = node;
  for (let i = 0; i < 6 && n; i++) {
    const t = n.type;
    if (/(declaration|definition|_item|_specifier|method|class|module)$/.test(t) || t === "variable_declarator") return n;
    n = n.parent;
  }
  return node;
}

function signatureOf(decl) {
  const first = (decl.text || "").split("\n")[0].trim();
  return first.replace(/\s*[{:(]?\s*$/, (m) => (m.includes("(") ? m : "")).replace(/\s*\{\s*$/, "").slice(0, 140);
}

// Parse a file once; shared by outline/def/refs. Returns null for unknown
// language, { empty:true } when the file can't be read.
async function parseFile(absPath) {
  const name = langForFile(absPath);
  if (!name) return null;
  let src;
  try { src = fs.readFileSync(absPath, "utf8"); } catch { return { empty: true }; }
  const { language, query } = await loadLang(name);
  const parser = new Parser();
  parser.setLanguage(language);
  return { name, src, language, query, tree: parser.parse(src) };
}

/** Extract a symbol outline for one file. Returns [] for unknown/parse-fail. */
export async function outlineFile(absPath) {
  const p = await parseFile(absPath);
  if (p == null) return null; // unknown language -> caller may fall back
  if (p.empty || !p.query) return [];
  const { query, tree } = p;
  const seen = new Set();
  const out = [];
  for (const cap of query.captures(tree.rootNode)) {
    const decl = declAncestor(cap.node);
    const line = decl.startPosition.row + 1;
    const key = cap.node.text + ":" + line;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: cap.name,
      name: cap.node.text,
      line,
      endLine: decl.endPosition.row + 1,
      sig: signatureOf(decl),
    });
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

/**
 * Does the file contain syntax errors? Parses with tree-sitter and checks the
 * tree for ERROR/MISSING nodes. Returns null for unknown/unreadable files so
 * callers can skip (don't claim a file is broken when we can't parse it).
 */
export async function hasParseErrors(absPath) {
  const p = await parseFile(absPath);
  if (p == null || p.empty) return null;
  const root = p.tree.rootNode;
  return typeof root.hasError === "function" ? !!root.hasError() : !!root.hasError;
}

/** Find DEFINITIONS of `symbol` in a file (declarations whose name matches). */
export async function findDefinitions(absPath, symbol) {
  const syms = await outlineFile(absPath);
  if (syms == null) return null;
  return syms.filter((s) => s.name === symbol);
}

/**
 * Find REFERENCES (every occurrence) of `symbol` in a file: all identifier-like
 * AST nodes whose text matches. Language-agnostic DFS — catches identifier,
 * property_identifier, field_identifier, type_identifier, etc.
 */
export async function findReferences(absPath, symbol) {
  const p = await parseFile(absPath);
  if (p == null) return null;
  if (p.empty) return [];
  const lines = p.src.split("\n");
  const out = [];
  const seen = new Set();
  const stack = [p.tree.rootNode];
  while (stack.length) {
    const n = stack.pop();
    if (/identifier/.test(n.type) && n.text === symbol) {
      const line = n.startPosition.row + 1;
      const key = line + ":" + n.startPosition.column;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ line, col: n.startPosition.column + 1, text: (lines[line - 1] || "").trim().slice(0, 160) });
      }
    }
    for (const c of n.namedChildren) stack.push(c);
  }
  out.sort((a, b) => a.line - b.line || a.col - b.col);
  return out;
}
