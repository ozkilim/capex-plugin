// Retroactive savings scanner (Woz-style `detect*`). Scans real Claude Code
// session transcripts for inefficiency patterns that CAPEX tools would collapse,
// and scores how many tool-call roundtrips would have been saved — priced at the
// session's REAL average per-turn cost. This measures waste that actually
// happened, rather than assuming it. Works on vanilla sessions too.
import fs from "node:fs";
import path from "node:path";
import { sumTranscript, perRoundtrip } from "./transcript.js";

const isGrep = (n) => n === "Grep" || n === "Glob";
const isRead = (n) => n === "Read" || n === "NotebookRead";
const isEdit = (n) => n === "Edit" || n === "MultiEdit" || n === "Write" || n === "NotebookEdit";
const SQL_RE = /\b(psql|sqlite3?|mysql|duckdb)\b|DATABASE_URL/i;

/**
 * Flatten a transcript into ordered tool-use "events" split into segments at
 * real (non-tool-result) user messages. Each event: { name, isError, isSql }.
 */
export function parseEvents(text) {
  const byId = new Map();
  const segments = [];
  let cur = [];
  // Dedupe duplicate-logged assistant messages (same message.id) so their
  // tool_uses aren't counted multiple times.
  const seenMsg = new Set();
  const pushSeg = () => { if (cur.length) { segments.push(cur); cur = []; } };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const msg = d.message;
    if (d.type === "assistant" && msg && Array.isArray(msg.content)) {
      const mid = msg.id || d.requestId || d.uuid;
      if (mid != null) { if (seenMsg.has(mid)) continue; seenMsg.add(mid); }
      for (const b of msg.content) {
        if (b && b.type === "tool_use") {
          const ev = {
            name: b.name,
            isError: false,
            isSql: b.name === "Bash" && SQL_RE.test((b.input && b.input.command) || ""),
          };
          if (b.id) byId.set(b.id, ev);
          cur.push(ev);
        }
      }
    } else if (d.type === "user" && msg) {
      const content = msg.content;
      if (typeof content === "string") { if (content.trim()) pushSeg(); continue; }
      if (Array.isArray(content)) {
        let hasResult = false, hasText = false;
        for (const b of content) {
          if (b && b.type === "tool_result") {
            hasResult = true;
            const ev = byId.get(b.tool_use_id);
            if (ev) ev.isError = b.is_error === true;
          } else if (b && b.type === "text") hasText = true;
        }
        if (hasText && !hasResult) pushSeg(); // a real user turn ends a workflow
      }
    }
  }
  pushSeg();
  return segments;
}

/** Detect inefficiency hits in one segment. Returns [{type, callsSaved}]. */
function detectSegment(evts) {
  const hits = [];
  const consumed = new Array(evts.length).fill(false);

  // failed-edit: an errored edit followed by read/edit until a successful edit.
  for (let i = 0; i < evts.length; i++) {
    if (consumed[i] || !isEdit(evts[i].name) || !evts[i].isError) continue;
    let j = i + 1, len = 1, success = false;
    for (; j < evts.length && j < i + 6; j++) {
      const n = evts[j].name;
      if (isRead(n)) { len++; continue; }
      if (isEdit(n)) { len++; if (!evts[j].isError) { success = true; j++; break; } continue; }
      break;
    }
    if (success && len >= 2) { for (let k = i; k < j; k++) consumed[k] = true; hits.push({ type: "failed_edit", callsSaved: len - 1 }); }
  }

  // grep/glob -> read(s): the reads are avoidable (Search returns content).
  for (let i = 0; i < evts.length; i++) {
    if (consumed[i] || !isGrep(evts[i].name)) continue;
    let j = i + 1, reads = 0;
    for (; j < evts.length; j++) {
      if (consumed[j]) break;
      if (isRead(evts[j].name)) { reads++; continue; }
      break;
    }
    if (reads >= 1) { for (let k = i; k < j; k++) consumed[k] = true; hits.push({ type: "grep_read", callsSaved: reads }); }
  }

  // bash-sql run: >=2 sqlite/psql Bash calls -> one Sql call.
  {
    let run = 0, start = -1;
    const flush = (end) => { if (run >= 2) { for (let k = start; k < end; k++) if (evts[k] && evts[k].isSql) consumed[k] = true; hits.push({ type: "bash_sql", callsSaved: run - 1 }); } run = 0; start = -1; };
    for (let i = 0; i < evts.length; i++) {
      if (evts[i].isSql && !consumed[i]) { if (start < 0) start = i; run++; }
      else if (run > 0 && !isRead(evts[i].name)) flush(i);
    }
    flush(evts.length);
  }

  // edit-batch: >=2 consecutive edits (reads interleaved ok) -> one batched Edit.
  {
    let edits = 0, tools = 0, start = -1;
    const flush = (end) => { if (edits >= 2) { const wozEq = 1; hits.push({ type: "edit_batch", callsSaved: tools - wozEq }); } edits = 0; tools = 0; start = -1; };
    for (let i = 0; i <= evts.length; i++) {
      const e = evts[i];
      if (e && !consumed[i] && (isEdit(e.name) || isRead(e.name))) {
        if (start < 0) start = i;
        tools++; if (isEdit(e.name)) edits++;
      } else { flush(i); }
    }
  }

  // read-batch: >=2 consecutive reads -> one batched read.
  {
    let reads = 0, start = -1;
    const flush = () => { if (reads >= 2) hits.push({ type: "read_batch", callsSaved: reads - 1 }); reads = 0; start = -1; };
    for (let i = 0; i <= evts.length; i++) {
      const e = evts[i];
      if (e && !consumed[i] && isRead(e.name)) { if (start < 0) start = i; reads++; }
      else flush();
    }
  }

  return hits.filter((h) => h.callsSaved > 0);
}

/** Scan one transcript file: returns hits, total calls saved, est. tokens/usd. */
export function scanTranscript(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch { return null; }
  const segments = parseEvents(text);
  const byType = {};
  let callsSaved = 0;
  for (const seg of segments) {
    for (const h of detectSegment(seg)) {
      byType[h.type] = (byType[h.type] || 0) + h.callsSaved;
      callsSaved += h.callsSaved;
    }
  }
  const rt = perRoundtrip(sumTranscript(filePath));
  return {
    callsSaved,
    byType,
    tokensSaved: Math.round(callsSaved * rt.tokens),
    usdSaved: callsSaved * rt.usd,
  };
}

/** Aggregate a scan across many transcript files. */
export function aggregate(results) {
  const total = { sessions: 0, callsSaved: 0, tokensSaved: 0, usdSaved: 0, byType: {} };
  for (const r of results) {
    if (!r) continue;
    total.sessions++;
    total.callsSaved += r.callsSaved;
    total.tokensSaved += r.tokensSaved;
    total.usdSaved += r.usdSaved;
    for (const [k, v] of Object.entries(r.byType)) total.byType[k] = (total.byType[k] || 0) + v;
  }
  return total;
}
