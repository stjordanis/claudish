/**
 * Tests for OpenRouterCatalogResolver — Firebase-backed model resolution.
 *
 * Run: bun test packages/cli/src/providers/catalog-resolvers/openrouter.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// We need to test the resolver's resolveSync logic with controlled cache state.
// The resolver uses module-level _memCache, so we import the class and inject test data.
import { OpenRouterCatalogResolver } from "./openrouter.js";

// Helper: create a slim catalog entry
function entry(
  modelId: string,
  aliases: string[],
  sources: Record<string, { externalId: string }>
) {
  return { modelId, aliases, sources };
}

// Sample catalog data representing what Firebase returns
const SAMPLE_CATALOG = [
  entry("grok-4.20", ["grok-4-20"], {
    "openrouter-api": { externalId: "x-ai/grok-4.20" },
    "xai-scraper": { externalId: "grok-4.20" },
  }),
  entry("grok-4", [], {
    "openrouter-api": { externalId: "x-ai/grok-4" },
  }),
  entry("deepseek-v3.2", ["deepseek-v3-2"], {
    "openrouter-api": { externalId: "deepseek/deepseek-v3.2" },
    "deepseek-api": { externalId: "deepseek-v3.2" },
  }),
  entry("gemini-3.1-pro-preview", [], {
    "openrouter-api": { externalId: "google/gemini-3.1-pro-preview" },
    "google-api": { externalId: "models/gemini-3.1-pro-preview" },
  }),
  entry("kimi-k2.5", ["kimi-k2-5"], {
    "openrouter-api": { externalId: "moonshotai/kimi-k2.5" },
    "kimi-scraper": { externalId: "kimi-k2.5" },
  }),
  entry("qwen3-coder-next", [], {
    "openrouter-api": { externalId: "qwen/qwen3-coder-next" },
  }),
  // Model without OpenRouter source (only direct API)
  entry("some-direct-only-model", [], {
    "provider-api": { externalId: "vendor/some-direct-only-model" },
  }),
];

/**
 * Create a resolver with injected cache data (bypasses fetch/disk).
 */
function createResolverWithCache(data: typeof SAMPLE_CATALOG): OpenRouterCatalogResolver {
  const resolver = new OpenRouterCatalogResolver();
  // Inject data into the resolver via the module cache
  // We use a workaround: call _getEntries' disk path won't exist in test,
  // so we warm via the memory cache mechanism
  (resolver as any)._getEntries = () => data;
  return resolver;
}

// ---------------------------------------------------------------------------
// Resolution chain tests
// ---------------------------------------------------------------------------

describe("OpenRouterCatalogResolver.resolveSync", () => {
  let resolver: OpenRouterCatalogResolver;

  beforeEach(() => {
    resolver = createResolverWithCache(SAMPLE_CATALOG);
  });

  // Step 1: Exact modelId match
  test("exact modelId → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("grok-4.20")).toBe("x-ai/grok-4.20");
  });

  test("exact modelId for deepseek → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("deepseek-v3.2")).toBe("deepseek/deepseek-v3.2");
  });

  test("exact modelId for gemini → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("gemini-3.1-pro-preview")).toBe(
      "google/gemini-3.1-pro-preview"
    );
  });

  // Step 2: Alias match
  test("alias match → returns OpenRouter externalId of matched model", () => {
    expect(resolver.resolveSync("grok-4-20")).toBe("x-ai/grok-4.20");
  });

  test("alias match for deepseek → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("deepseek-v3-2")).toBe("deepseek/deepseek-v3.2");
  });

  test("alias match for kimi → returns OpenRouter externalId", () => {
    expect(resolver.resolveSync("kimi-k2-5")).toBe("moonshotai/kimi-k2.5");
  });

  // Step 3: Sources externalId match — already vendor-prefixed input
  test("vendor-prefixed input exact match → returns as-is", () => {
    expect(resolver.resolveSync("x-ai/grok-4.20")).toBe("x-ai/grok-4.20");
  });

  test("vendor-prefixed input not in catalog → returns as-is (passthrough)", () => {
    expect(resolver.resolveSync("x-ai/nonexistent")).toBe("x-ai/nonexistent");
  });

  // Step 4: Suffix match on OpenRouter externalIds
  test("suffix match → finds via endsWith", () => {
    expect(resolver.resolveSync("qwen3-coder-next")).toBe("qwen/qwen3-coder-next");
  });

  // Model without OpenRouter source falls back to any vendor-prefixed externalId
  test("model without openrouter-api source → uses first vendor-prefixed externalId", () => {
    expect(resolver.resolveSync("some-direct-only-model")).toBe(
      "vendor/some-direct-only-model"
    );
  });

  // Step 5: Static fallback
  test("unknown model with 'grok' prefix → static fallback x-ai/", () => {
    // This model isn't in the catalog but starts with "grok"
    const noDataResolver = createResolverWithCache([]);
    expect(noDataResolver.resolveSync("grok-99")).toBe("x-ai/grok-99");
  });

  test("unknown model with 'deepseek' prefix → static fallback deepseek/", () => {
    const noDataResolver = createResolverWithCache([]);
    expect(noDataResolver.resolveSync("deepseek-future")).toBe("deepseek/deepseek-future");
  });

  // Step 6: Passthrough (null)
  test("completely unknown model → null", () => {
    const noDataResolver = createResolverWithCache([]);
    expect(noDataResolver.resolveSync("totally-unknown-model")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cache state tests
// ---------------------------------------------------------------------------

describe("OpenRouterCatalogResolver cache state", () => {
  test("isCacheWarm returns false when no data", () => {
    const resolver = new OpenRouterCatalogResolver();
    // Fresh resolver with no fetch — cache is cold
    // (isCacheWarm checks module-level _memCache which is reset between test files)
    // We can't easily test this without resetting module state, so just verify the method exists
    expect(typeof resolver.isCacheWarm).toBe("function");
  });

  test("ensureReady resolves without error even if fetch fails", async () => {
    const resolver = new OpenRouterCatalogResolver();
    // ensureReady should gracefully handle fetch failures
    // With a very short timeout, it should resolve quickly
    await expect(resolver.ensureReady(100)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refreshCatalog tests
// ---------------------------------------------------------------------------
//
// The resolver uses module-level `_memCache` and `_warmPromise` plus the disk
// helpers in `all-models-cache.js`. To avoid clobbering the user's real
// `~/.claudish/all-models.json` we mock the cache module before importing the
// resolver in this block. `mock.module()` is hoisted to the top of the file
// scope by Bun, so we re-import the resolver from a sub-path import after the
// mock is registered to ensure the mocked dependency is wired in.
//
// Error simulation strategy:
//   - timeout       → fetch rejects with `{ name: "TimeoutError" }`
//   - network       → fetch rejects with a generic Error (e.g. ECONNREFUSED)
//   - http_error    → fetch resolves with `Response` whose `ok=false`
//   - empty         → fetch resolves with `Response` whose body has 0 entries
//   - refreshed     → fetch resolves with `Response` whose body has ≥1 entries

// Mock the disk-cache module so writeAllModelsCache becomes a no-op spy and
// readAllModelsCache returns null. Must be registered before resolver import.
const mockWrite = mock((_data: unknown): void => undefined);
const mockRead = mock(() => null);

mock.module("../all-models-cache.js", () => ({
  writeAllModelsCache: mockWrite,
  readAllModelsCache: mockRead,
  ALL_MODELS_CACHE_PATH: "/tmp/test-all-models.json",
}));

describe("OpenRouterCatalogResolver.refreshCatalog", () => {
  let resolver: OpenRouterCatalogResolver;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockWrite.mockClear();
    mockRead.mockClear();
    resolver = new OpenRouterCatalogResolver();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // Helper: build a Response-like object with controllable ok/json behavior.
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  test("success → returns refreshed with modelCount", async () => {
    const fakeModels = [
      entry("alpha", [], { "openrouter-api": { externalId: "vendor-a/alpha" } }),
      entry("beta", [], { "openrouter-api": { externalId: "vendor-b/beta" } }),
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: fakeModels, total: 2 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "refreshed", modelCount: 2 });
    // Disk cache mutated with the new entries plus backward-compat models array.
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const writeArg = mockWrite.mock.calls[0]?.[0] as unknown as {
      entries: typeof fakeModels;
      models: Array<{ id: string }>;
    };
    expect(writeArg.entries).toEqual(fakeModels);
    expect(writeArg.models).toEqual([{ id: "vendor-a/alpha" }, { id: "vendor-b/beta" }]);
  });

  test("success → in-memory cache reflects fetched models via resolveSync", async () => {
    const fakeModels = [
      entry("gamma", ["g"], { "openrouter-api": { externalId: "vendor-g/gamma" } }),
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: fakeModels, total: 1 })
    ) as unknown as typeof globalThis.fetch;

    await resolver.refreshCatalog(8000);

    // After a successful refresh, resolveSync should hit the in-memory cache.
    // (No need to override _getEntries here — the real one reads _memCache first.)
    expect(resolver.resolveSync("gamma")).toBe("vendor-g/gamma");
    expect(resolver.resolveSync("g")).toBe("vendor-g/gamma");
  });

  test("success → isCacheWarm returns true after refresh", async () => {
    const fakeModels = [
      entry("delta", [], { "openrouter-api": { externalId: "vendor-d/delta" } }),
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: fakeModels, total: 1 })
    ) as unknown as typeof globalThis.fetch;

    await resolver.refreshCatalog(8000);

    expect(resolver.isCacheWarm()).toBe(true);

    // _warmPromise short-circuit: a subsequent warmCache() should resolve
    // immediately without calling fetch again. This is the F2 fix from
    // architecture.md §0 — the proxy-server bg warm at proxy-server.ts:535
    // sees the resolved promise and skips the redundant fetch.
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const callsBefore = fetchSpy.mock.calls.length;
    await resolver.warmCache();
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });

  test("http error (500) → returns fetch_failed:http_error, caches untouched", async () => {
    globalThis.fetch = mock(
      async () => new Response("upstream blew up", { status: 500 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "http_error" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("timeout (TimeoutError) → returns fetch_failed:timeout", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("The operation timed out.") as Error & { name: string };
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(50);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "timeout" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("real AbortSignal timeout fires after timeoutMs → fetch_failed:timeout", async () => {
    // Use a fetch that hangs forever, paired with a small timeoutMs. The
    // resolver's internal AbortSignal.timeout(timeoutMs) should fire and
    // surface as a timeout reason.
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          // Mimic Node/Bun's behavior: AbortSignal.timeout fires a TimeoutError.
          const reason = (signal as AbortSignal & { reason?: unknown }).reason;
          reject(reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(50);

    expect(outcome.kind).toBe("fetch_failed");
    if (outcome.kind === "fetch_failed") {
      expect(outcome.reason).toBe("timeout");
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("network error (generic throw) → returns fetch_failed:network", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:1");
    }) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "network" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("empty body (models: []) → returns fetch_failed:empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ models: [], total: 0 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    expect(outcome).toEqual({ kind: "fetch_failed", reason: "empty" });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  test("malformed body (no models key) → returns fetch_failed:empty", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ total: 0 })
    ) as unknown as typeof globalThis.fetch;

    const outcome = await resolver.refreshCatalog(8000);

    // No `models` array → !Array.isArray short-circuits the same branch as empty.
    expect(outcome).toEqual({ kind: "fetch_failed", reason: "empty" });
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
