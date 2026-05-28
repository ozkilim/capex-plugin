// Anthropic Sonnet input price as of model release (USD per million tokens).
// Update if you switch baseline model.
export const PRICE_INPUT_PER_MTOK = 3.00;
export const PRICE_OUTPUT_PER_MTOK = 15.00;

// Rough constants for the "what would vanilla have cost" baseline.
export const VANILLA_PER_ROUNDTRIP_TOKENS = 1500;  // model re-thinking cost per extra tool call
export const VANILLA_PER_FILE_READ_TOKENS = 800;   // average file read result size

const zero = () => ({ tokensSaved: 0, roundtripsSaved: 0, msSaved: 0, usdSaved: 0 });

export function estimateSavings(meta) {
  // Returns { tokensSaved, roundtripsSaved, msSaved, usdSaved }
  if (!meta || typeof meta !== "object") return zero();
  switch (meta.mode) {
    case "search": {
      // 1 Search call replaces (Glob + Grep + N reads). Assume ~3 vanilla calls per Search.
      const roundtripsSaved = 3;
      const tokensSaved = roundtripsSaved * VANILLA_PER_ROUNDTRIP_TOKENS
        + Math.min(meta.matches ?? 0, 5) * VANILLA_PER_FILE_READ_TOKENS;
      return {
        tokensSaved,
        roundtripsSaved,
        msSaved: 4000,
        usdSaved: (tokensSaved / 1_000_000) * PRICE_INPUT_PER_MTOK
      };
    }
    case "edit": {
      const extra = Math.max(0, (meta.batchSize ?? 1) - 1);
      const tokensSaved = extra * VANILLA_PER_ROUNDTRIP_TOKENS;
      return {
        tokensSaved,
        roundtripsSaved: extra,
        msSaved: extra * 1500,
        usdSaved: (tokensSaved / 1_000_000) * PRICE_INPUT_PER_MTOK
      };
    }
    case "read": {
      if (!meta.truncated && !meta.signaturesOnly) return zero();
      // Estimate ~70% of full file tokens saved on a signatures_only read.
      const tokensSaved = Math.round((meta.totalLines ?? 0) * 10 * 0.7);
      return {
        tokensSaved,
        roundtripsSaved: 0,
        msSaved: 0,
        usdSaved: (tokensSaved / 1_000_000) * PRICE_INPUT_PER_MTOK
      };
    }
    default:
      return zero();
  }
}
