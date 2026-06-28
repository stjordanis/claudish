/**
 * CatalogClient — single entry point for all Firebase-backed model catalog
 * questions. Replaces the three independent slug maps and per-provider
 * catalog calls with one interface over `model-loader.ts`.
 *
 * Caching policy: only Firebase responses go to disk; all caches share
 * `FIREBASE_CACHE_TTL_HOURS` from `cache-ttl.ts`. Direct-provider catalog
 * calls (Zen, LiteLLM `/model_group/info`) are removed in commit 5.
 *
 * See `ai-docs/sessions/dev-arch-20260427-140813-663f2981/architecture.md`
 * (plan §A) and `firebase-reality-check.md` for the data shape we read.
 */

import {
  getModelByIdFromFirebase,
  getModelsByProvider,
  searchModels as searchModelsFromFirebase,
  type AggregatorEntry,
  type ModelDoc,
} from "../model-loader.js";
import { readAllModelsCache, type SlimModelEntry } from "./all-models-cache.js";
import { FIREBASE_CACHE_TTL_MS } from "./cache-ttl.js";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Catalog-shaped model record used by picker, routing-rules, and search UX.
 * A subset of `ModelDoc` chosen so callers don't depend on the full Firebase
 * schema — fields are added here as new picker/routing surfaces need them.
 */
export interface CatalogModel {
  modelId: string;
  displayName: string;
  /**
   * Owner provider (e.g. "anthropic", "openai"). Optional because the slim
   * catalog (used by aggregator-vendor queries) does not carry the owner
   * field — only `aggregators[]`. Callers that need the owner should query
   * via `modelsByVendor(<owner-slug>)` which uses the rich provider query.
   */
  provider?: string;
  description?: string;
  aggregators?: AggregatorEntry[];
  contextWindow?: number;
  supportsVision?: boolean;
  pricing?: ModelDoc["pricing"];
  releaseDate?: string;
  capabilities?: ModelDoc["capabilities"];
}

/**
 * The `CatalogClient` interface. Implemented by `createCatalogClient()`.
 *
 * Three operations, all backed by Firebase. Each is intentionally small so
 * the picker and routing layer can replace their hardcoded slug tables
 * with a single dependency.
 */
export interface CatalogClient {
  /**
   * All models a vendor SERVES. `vendorSlug` is a Firebase aggregator
   * provider name (e.g. "opencode-zen", "openrouter", "anthropic", "google").
   *
   * For owner-providers (e.g. "anthropic"): returns the rich provider query
   * `getModelsByProvider(slug)`.
   *
   * For aggregator/gateway providers (e.g. "opencode-zen", "openrouter"):
   * returns models whose `aggregators[]` lists this vendor. Reads from the
   * slim catalog cache at ~/.claudish/all-models.json (24h TTL).
   *
   * For LiteLLM, Ollama, LM Studio: returns []. These have no Firebase
   * catalog by design — callers handle this with a free-text input prompt.
   */
  modelsByVendor(vendorSlug: string): Promise<CatalogModel[]>;

  /**
   * Aggregators that serve a given model. Reads from slim catalog cache.
   * Returns null if the model isn't in the catalog (caller decides whether
   * to error or attempt the request anyway).
   */
  vendorsForModel(modelId: string): Promise<AggregatorEntry[] | null>;

  /**
   * Cross-vendor search. Delegates to Firebase `?search=...` for live results.
   */
  searchModels(term: string, limit?: number): Promise<CatalogModel[]>;
}

// ─── Slug classification ─────────────────────────────────────────────────────

/**
 * Vendors that OWN models — these are values that appear in the Firebase
 * `provider` field and answer the rich `?provider=...` query well. When a
 * slug is in this set we prefer `getModelsByProvider()` which returns the
 * full ModelDoc shape.
 *
 * Note: a slug can be BOTH an owner and an aggregator (e.g. "anthropic" owns
 * Claude models AND appears in some `aggregators[]` lists). The owner path
 * wins because it returns more complete data.
 */
const OWNER_PROVIDER_SLUGS = new Set<string>([
  "anthropic",
  "openai",
  "google",
  "x-ai",
  "z-ai",
  "deepseek",
  "minimax",
  "moonshotai",
  "qwen",
  "sakana",
]);

/**
 * Vendors that SERVE other owners' models — these appear as
 * `aggregators[].provider` values in the slim catalog. For these slugs
 * `modelsByVendor()` filters the slim cache.
 */
const AGGREGATOR_PROVIDER_SLUGS = new Set<string>([
  "openrouter",
  "opencode-zen",
  "opencode-zen-go",
  "fireworks",
  "together-ai",
]);

/**
 * Local-only / undocumented-catalog vendors. These have no Firebase catalog
 * by design; the picker shows a free-text input instead of a model list.
 */
const NO_CATALOG_VENDOR_SLUGS = new Set<string>([
  "litellm",
  "ollama",
  "lmstudio",
  "lm-studio",
]);

// ─── Internal helpers ────────────────────────────────────────────────────────

function modelDocToCatalogModel(doc: ModelDoc): CatalogModel {
  return {
    modelId: doc.modelId,
    displayName: doc.displayName ?? doc.modelId,
    provider: doc.provider,
    description: doc.description,
    aggregators: doc.aggregators,
    contextWindow: doc.contextWindow,
    supportsVision: doc.capabilities?.vision,
    pricing: doc.pricing,
    releaseDate: doc.releaseDate,
    capabilities: doc.capabilities,
  };
}

function slimEntryToCatalogModel(entry: SlimModelEntry): CatalogModel {
  return {
    modelId: entry.modelId,
    displayName: entry.modelId,
    // `provider` (owner) is intentionally omitted — the slim catalog doesn't
    // carry it. Aggregator queries are about "who serves this model", not
    // "who owns this model"; callers don't need owner here.
    aggregators: entry.aggregators,
    contextWindow: entry.contextWindow,
    supportsVision: entry.supportsVision,
    releaseDate: entry.releaseDate,
  };
}

/**
 * Read the slim cache fresh-or-stale, plus a flag indicating whether it's
 * past the shared TTL. Callers use the flag to decide whether to try a live
 * Firebase fetch as a fallback.
 *
 * Firebase-derived data — OK to cache locally per the catalog policy.
 * TTL shared with all other Firebase caches via FIREBASE_CACHE_TTL_HOURS.
 */
function readSlimCacheWithFreshness(
  reader: () => ReturnType<typeof readAllModelsCache>
): { entries: SlimModelEntry[]; stale: boolean } {
  const cache = reader();
  if (!cache) return { entries: [], stale: true };

  const lastUpdatedMs = new Date(cache.lastUpdated).getTime();
  const ageMs = Date.now() - lastUpdatedMs;
  const stale = !Number.isFinite(lastUpdatedMs) || ageMs > FIREBASE_CACHE_TTL_MS;

  return { entries: cache.entries ?? [], stale };
}

// ─── Dependency injection ────────────────────────────────────────────────────

/**
 * Optional dependency overrides for testing. Production callers pass nothing
 * and get the real `model-loader.ts` + `all-models-cache.ts` wiring.
 */
export interface CatalogClientDeps {
  getModelsByProvider?: typeof getModelsByProvider;
  getModelByIdFromFirebase?: typeof getModelByIdFromFirebase;
  searchModels?: typeof searchModelsFromFirebase;
  /** Returns the parsed slim cache or null. Default reads ~/.claudish/all-models.json. */
  readSlimCache?: () => ReturnType<typeof readAllModelsCache>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct a `CatalogClient`. Pass `deps` only in tests — real callers omit
 * the argument and get the production wiring.
 */
export function createCatalogClient(deps: CatalogClientDeps = {}): CatalogClient {
  const _getModelsByProvider = deps.getModelsByProvider ?? getModelsByProvider;
  const _getModelByIdFromFirebase =
    deps.getModelByIdFromFirebase ?? getModelByIdFromFirebase;
  const _searchModels = deps.searchModels ?? searchModelsFromFirebase;
  const _readSlimCache = deps.readSlimCache ?? readAllModelsCache;

  return {
    async modelsByVendor(vendorSlug: string): Promise<CatalogModel[]> {
      const slug = vendorSlug.toLowerCase();

      // No-catalog vendors short-circuit without I/O. Picker is expected to
      // detect [] and switch to the free-text input path.
      if (NO_CATALOG_VENDOR_SLUGS.has(slug)) return [];

      // Owners → rich provider query (returns full ModelDoc).
      if (OWNER_PROVIDER_SLUGS.has(slug)) {
        const docs = await _getModelsByProvider(slug);
        return docs.map(modelDocToCatalogModel);
      }

      // Aggregators → filter slim cache by aggregators[].provider.
      // Firebase-derived data — OK to cache locally per the catalog policy.
      if (AGGREGATOR_PROVIDER_SLUGS.has(slug)) {
        const { entries } = readSlimCacheWithFreshness(_readSlimCache);
        const matches = entries.filter((entry) =>
          entry.aggregators?.some((agg) => agg.provider.toLowerCase() === slug)
        );
        return matches.map(slimEntryToCatalogModel);
      }

      // Unknown slug — fall through to the rich provider query. Firebase
      // returns [] for genuinely unknown providers; this preserves the
      // owner-path completeness for any new owner slug we haven't enumerated
      // here yet.
      const docs = await _getModelsByProvider(slug);
      return docs.map(modelDocToCatalogModel);
    },

    async vendorsForModel(modelId: string): Promise<AggregatorEntry[] | null> {
      // Firebase-derived data — OK to cache locally per the catalog policy.
      // TTL shared with all other Firebase caches via FIREBASE_CACHE_TTL_HOURS.
      const { entries, stale } = readSlimCacheWithFreshness(_readSlimCache);

      // Try the in-cache lookup first regardless of staleness — even a stale
      // cache is better than a network round-trip if the model is present.
      for (const entry of entries) {
        if (entry.modelId === modelId || entry.aliases.includes(modelId)) {
          return entry.aggregators ?? [];
        }
      }

      // Cache miss. If the cache is fresh and the model wasn't there, treat
      // the catalog as authoritative for this question and return null.
      if (!stale) return null;

      // Stale (or empty) cache + cache miss: fall back to live Firebase to
      // give the caller a definitive answer. We don't refresh the slim cache
      // here — that's a separate code path (openrouter resolver) and adding
      // a fire-and-forget refresh from the catalog read site has historically
      // caused interleaved-write bugs.
      const doc = await _getModelByIdFromFirebase(modelId);
      if (!doc) return null;
      return doc.aggregators ?? [];
    },

    async searchModels(term: string, limit = 50): Promise<CatalogModel[]> {
      const docs = await _searchModels(term, limit);
      return docs.map(modelDocToCatalogModel);
    },
  };
}
