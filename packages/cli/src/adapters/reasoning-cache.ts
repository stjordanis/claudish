/**
 * Reasoning-item cache for the OpenAI Responses API.
 *
 * OpenAI's reasoning guide: "Pass back all reasoning items from function calls
 * (along with function outputs) to maintain the model's reasoning continuity.
 * This allows more efficient token usage and better results across multi-step
 * tool-heavy workflows."
 *
 * Measured on gpt-5.6-sol (codex, high effort) across a tool boundary:
 *
 *   with reasoning replayed:  reasoning_tokens 97 / 39   output 118 / 60
 *   without (dropping them):  reasoning_tokens 458 / 347  output 479 / 368
 *
 * ~6x fewer reasoning tokens for ~390 extra input tokens — and output bills at
 * 6x the input rate. It also cuts consumption of the output budget, which is the
 * budget that overflows as `incomplete_details.reason = "max_output_tokens"` and
 * truncates a tool call mid-argument.
 *
 * Why a cache instead of round-tripping through the client: the reasoning payload
 * is an opaque `encrypted_content` blob that has no home in the Anthropic wire
 * format. The obvious carrier — a thinking block's `signature` — does not work,
 * because reasoning items arrive with `summary: []` far more often than not (the
 * summary is intermittent), so most turns produce no thinking block at all to
 * attach a signature to. The proxy process outlives the whole session, so we key
 * the items by the tool call they preceded and re-insert them on replay.
 *
 * The cache is best-effort: a miss simply reproduces the previous behaviour
 * (the model re-reasons), so a proxy restart degrades rather than breaks.
 */

/** A reasoning item, shaped for replay in a Responses `input` array. */
export interface CachedReasoningItem {
  type: "reasoning";
  content?: unknown[];
  encrypted_content?: string;
  summary?: unknown[];
}

/**
 * Bound the cache so a long session cannot grow unbounded. Entries are a few KB
 * each (encrypted_content ~1-3KB), so this caps us in the low megabytes. Insert
 * order is eviction order — the oldest tool call is the least likely to still be
 * in the client's replayed history.
 */
const MAX_ENTRIES = 500;

/** tool call id (as seen by the client) → reasoning items that preceded it */
const cache = new Map<string, CachedReasoningItem[]>();

/**
 * Associate reasoning items with the tool call they immediately preceded.
 * Called with the client-facing call id, which is what comes back on replay.
 */
export function rememberReasoningForCall(callId: string, items: CachedReasoningItem[]): void {
  if (!callId || items.length === 0) return;

  // Re-inserting refreshes recency, so keep the map key order meaningful.
  if (cache.has(callId)) cache.delete(callId);
  cache.set(callId, items);

  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Reasoning items to replay immediately before this tool call, if any. */
export function reasoningForCall(callId: string): CachedReasoningItem[] | undefined {
  return cache.get(callId);
}

/** Test seam / session reset. */
export function clearReasoningCache(): void {
  cache.clear();
}

/** Test seam. */
export function reasoningCacheSize(): number {
  return cache.size;
}
