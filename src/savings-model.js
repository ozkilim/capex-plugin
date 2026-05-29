// CAPEX savings model — transcript-grounded.
//
// The old model priced every avoided roundtrip at a flat 1500-token constant
// and credited every Search with 3 saved roundtrips. Our A/B benchmark (bench/)
// showed both assumptions are wrong:
//   - The marginal cost of an avoided roundtrip is the whole re-sent context of
//     THIS session, which varies wildly run to run — a constant can't capture it.
//   - On small/typical repos a single Search does NOT reliably save 3 roundtrips;
//     batched Edit is where real, repeatable roundtrip savings come from
//     (9 vanilla turns -> 3 with one batched Edit, ~half the fresh tokens).
//
// So this model: (1) prices a saved roundtrip at the REAL average per-turn cost
// of the live session, supplied by the caller from the transcript (see
// src/transcript.js / scripts/tracking-hook.js); (2) credits roundtrips
// conservatively and honestly per tool. Everything is still labeled "est."
export const PRICE_INPUT_PER_MTOK = 3.0;
export const PRICE_OUTPUT_PER_MTOK = 15.0;

// Fallback marginal roundtrip cost, used only when the caller can't supply live
// transcript context (e.g. the very first tool call before any turn exists).
// Conservative on purpose; the real number comes from the session transcript.
export const FALLBACK_ROUNDTRIP_TOKENS = 1200;
const BASELINE_TURN_MS = 1500;

const zero = () => ({ tokensSaved: 0, roundtripsSaved: 0, msSaved: 0, usdSaved: 0 });

/**
 * @param {object} meta  per-tool meta ({ mode, batchSize, matches, ... })
 * @param {object} [ctx] live session context from the transcript:
 *   { perRoundtripTokens, perRoundtripUsd } — average billed tokens/$ per turn.
 */
export function estimateSavings(meta, ctx = {}) {
  if (!meta || typeof meta !== "object") return zero();

  const rtTokens = ctx.perRoundtripTokens ?? FALLBACK_ROUNDTRIP_TOKENS;
  const rtUsd = ctx.perRoundtripUsd ?? (rtTokens / 1_000_000) * PRICE_INPUT_PER_MTOK;
  const fromRoundtrips = (n) => ({
    tokensSaved: Math.round(n * rtTokens),
    roundtripsSaved: n,
    msSaved: n * BASELINE_TURN_MS,
    usdSaved: n * rtUsd,
  });

  switch (meta.mode) {
    case "edit": {
      // The strongest, most repeatable win: each edit beyond the first would
      // have been its own Edit call (its own roundtrip) in vanilla flow.
      const saved = Math.max(0, (meta.batchSize ?? 1) - 1);
      return fromRoundtrips(saved);
    }
    case "replace": {
      // Highest-leverage win: a server-side multi-file replace does the mutation
      // and returns a tiny summary, so it avoids (a) one Edit roundtrip per file
      // and (b) re-emitting the edits as 5×-priced output. Credit one avoided
      // roundtrip per file touched.
      const saved = Math.max(0, meta.files ?? 0);
      return fromRoundtrips(saved);
    }
    case "runtests": {
      // Returns only failures + counts instead of the runner's full stdout,
      // which would otherwise be billed once and re-billed as cache-read every
      // subsequent turn of an edit-test loop. Credit the avoided re-read turn.
      return fromRoundtrips(1);
    }
    case "view": {
      // Symbol-scoped read: only the symbol's body entered context, not the
      // whole file. Context-SIZE saving ≈ the elided lines.
      const elided = Math.max(0, (meta.totalLines ?? 0) - (meta.linesReturned ?? 0));
      const tokensSaved = Math.round(elided * 10 * 0.7);
      return {
        tokensSaved,
        roundtripsSaved: 0,
        msSaved: 0,
        usdSaved: (tokensSaved / 1_000_000) * PRICE_INPUT_PER_MTOK,
      };
    }
    case "map": {
      // Cold-start orientation: one call instead of ls + reading several files.
      // Credit avoided reads conservatively (capped), plus the context saving of
      // never pulling those bodies in.
      const saved = Math.max(0, Math.min(meta.sourceFiles ?? 0, 8));
      return fromRoundtrips(saved);
    }
    case "imports": {
      const saved = Math.max(0, Math.min(meta.files ?? 0, 5));
      return fromRoundtrips(saved);
    }
    case "insert": {
      // An addition done without echoing an anchor, and with no failed-match
      // retry risk. One avoided roundtrip when something was inserted.
      return fromRoundtrips(meta.inserted ? 1 : 0);
    }
    case "where": {
      // Fuses Def + Refs (2 calls -> 1) and avoids reading each hit file.
      const saved = 1 + Math.max(0, Math.min(meta.files ?? 0, 4));
      return fromRoundtrips(saved);
    }
    case "run": {
      // Suppresses a verification command's full output (re-billed every turn).
      return fromRoundtrips(1);
    }
    case "sql": {
      // One Sql call replaces a sqlite3 Bash invocation (often part of a loop).
      return fromRoundtrips(meta.ran === false ? 0 : 1);
    }
    case "refs":
    case "def": {
      // AST symbol lookup across the repo replaces grep + reading each hit file.
      // Credit one avoided roundtrip per file that had a hit (capped), priced
      // at the session's real per-turn cost.
      const saved = Math.max(0, Math.min(meta.files ?? 0, 5));
      return fromRoundtrips(saved);
    }
    case "search": {
      // Conservative: one consolidated Glob+Grep+read call instead of a
      // separate grep then read. Credited only when the search actually
      // returned matches; never the inflated "3 per search" of the old model.
      const saved = (meta.matches ?? 0) > 0 ? 1 : 0;
      return fromRoundtrips(saved);
    }
    case "outline": {
      // AST symbol map instead of reading whole files: a context-size saving
      // (bodies never enter context) plus a roundtrip saving when it covers
      // many files in one call (vs one Read each).
      const rts = Math.max(0, (meta.files ?? 0) - 1);
      const ctxTokens = Math.round((meta.linesElided ?? 0) * 10 * 0.8);
      return {
        tokensSaved: ctxTokens + Math.round(rts * rtTokens),
        roundtripsSaved: rts,
        msSaved: rts * BASELINE_TURN_MS,
        usdSaved: (ctxTokens / 1_000_000) * PRICE_INPUT_PER_MTOK + rts * rtUsd,
      };
    }
    case "read": {
      // Not a roundtrip saving — a context-SIZE saving. signatures_only elides
      // function bodies; estimate ~70% of the file's tokens never entered context.
      if (!meta.truncated && !meta.signaturesOnly) return zero();
      const tokensSaved = Math.round((meta.totalLines ?? 0) * 10 * 0.7);
      return {
        tokensSaved,
        roundtripsSaved: 0,
        msSaved: 0,
        usdSaved: (tokensSaved / 1_000_000) * PRICE_INPUT_PER_MTOK,
      };
    }
    default:
      return zero();
  }
}
