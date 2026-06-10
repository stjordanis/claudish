/**
 * Tests for `providers/model-catalog.ts` — the `CatalogClient` interface.
 *
 * Tests use dependency injection (the optional `deps` argument to
 * `createCatalogClient`) to substitute fake `model-loader.ts` functions and
 * a fake slim-cache reader. This matches the codebase convention (see
 * openrouter.test.ts) since the project doesn't use `mock.module()`.
 *
 * Run: bun test packages/cli/src/providers/model-catalog.test.ts
 */

import { describe, test, expect, mock } from "bun:test";
import { createCatalogClient } from "./model-catalog.js";
import { FIREBASE_CACHE_TTL_MS } from "./cache-ttl.js";
import type { AggregatorEntry, ModelDoc } from "../model-loader.js";
import type { DiskCacheV2, SlimModelEntry } from "./all-models-cache.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function aggregator(provider: string, externalId: string): AggregatorEntry {
  return { provider, externalId, confidence: "gateway_official" };
}

function slimEntry(
  modelId: string,
  aggregators: AggregatorEntry[],
  aliases: string[] = []
): SlimModelEntry {
  return {
    modelId,
    aliases,
    sources: {},
    aggregators,
  };
}

function modelDoc(modelId: string, provider: string, extra: Partial<ModelDoc> = {}): ModelDoc {
  return {
    modelId,
    provider,
    displayName: modelId,
    ...extra,
  };
}

function freshCache(entries: SlimModelEntry[]): DiskCacheV2 {
  return {
    version: 2,
    lastUpdated: new Date().toISOString(),
    entries,
    models: [],
  };
}

function staleCache(entries: SlimModelEntry[]): DiskCacheV2 {
  return {
    version: 2,
    // Twice the TTL — definitely expired.
    lastUpdated: new Date(Date.now() - 2 * FIREBASE_CACHE_TTL_MS).toISOString(),
    entries,
    models: [],
  };
}

// ─── modelsByVendor ──────────────────────────────────────────────────────────

describe("modelsByVendor", () => {
  test("owner provider 'anthropic' calls getModelsByProvider once", async () => {
    const fakeProviderQuery = mock(async (_slug: string) => [
      modelDoc("claude-opus-4-7", "anthropic"),
      modelDoc("claude-sonnet-4-5", "anthropic"),
    ]);
    const fakeReadSlim = mock(() => null);

    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: fakeReadSlim,
    });

    const result = await client.modelsByVendor("anthropic");

    expect(fakeProviderQuery).toHaveBeenCalledTimes(1);
    expect(fakeProviderQuery.mock.calls[0]?.[0]).toBe("anthropic");
    // Slim cache must NOT be touched on the owner path.
    expect(fakeReadSlim).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0]?.modelId).toBe("claude-opus-4-7");
  });

  test("aggregator 'opencode-zen' filters slim cache by aggregators[].provider", async () => {
    const entries = [
      slimEntry("claude-opus-4-7", [
        aggregator("anthropic", "claude-opus-4-7"),
        aggregator("opencode-zen", "anthropic/claude-opus-4-7"),
      ]),
      slimEntry("gpt-5", [
        aggregator("openai", "gpt-5"),
        aggregator("opencode-zen", "openai/gpt-5"),
      ]),
      // No opencode-zen → must be filtered out.
      slimEntry("grok-4", [aggregator("x-ai", "grok-4")]),
    ];

    const fakeProviderQuery = mock(async () => []);
    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.modelsByVendor("opencode-zen");

    expect(result.map((m) => m.modelId).sort()).toEqual(
      ["claude-opus-4-7", "gpt-5"].sort()
    );
    // Aggregator path must not hit the rich provider query.
    expect(fakeProviderQuery).not.toHaveBeenCalled();
  });

  test("aggregator returns [] when slim cache is empty", async () => {
    const client = createCatalogClient({
      getModelsByProvider: mock(async () => []),
      readSlimCache: () => null,
    });

    const result = await client.modelsByVendor("opencode-zen");
    expect(result).toEqual([]);
  });

  test("aggregator slug match is case-insensitive", async () => {
    const entries = [
      slimEntry("claude-opus-4-7", [aggregator("OpenCode-Zen", "x")]),
    ];
    const client = createCatalogClient({
      getModelsByProvider: mock(async () => []),
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.modelsByVendor("opencode-zen");
    expect(result).toHaveLength(1);
  });

  test.each([
    ["litellm"],
    ["ollama"],
    ["lmstudio"],
    ["lm-studio"],
  ])("'%s' returns [] without any I/O", async (slug) => {
    const fakeProviderQuery = mock(async () => []);
    const fakeReadSlim = mock(() => null);

    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: fakeReadSlim,
    });

    const result = await client.modelsByVendor(slug);

    expect(result).toEqual([]);
    expect(fakeProviderQuery).not.toHaveBeenCalled();
    expect(fakeReadSlim).not.toHaveBeenCalled();
  });

  test("unknown slug falls through to rich provider query", async () => {
    const fakeProviderQuery = mock(async (slug: string) => {
      expect(slug).toBe("brand-new-vendor");
      return [];
    });

    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => null,
    });

    const result = await client.modelsByVendor("brand-new-vendor");
    expect(result).toEqual([]);
    expect(fakeProviderQuery).toHaveBeenCalledTimes(1);
  });
});

// ─── vendorsForModel ─────────────────────────────────────────────────────────

describe("vendorsForModel", () => {
  test("returns aggregators[] from slim cache when model is present", async () => {
    const aggs = [
      aggregator("anthropic", "claude-opus-4-7"),
      aggregator("openrouter", "anthropic/claude-opus-4-7"),
    ];
    const entries = [slimEntry("claude-opus-4-7", aggs)];

    const fakeFirebaseLookup = mock(async () => null);
    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.vendorsForModel("claude-opus-4-7");
    expect(result).toEqual(aggs);
    // Cache hit should not trigger the live Firebase fallback.
    expect(fakeFirebaseLookup).not.toHaveBeenCalled();
  });

  test("alias hit returns the underlying entry's aggregators", async () => {
    const aggs = [aggregator("openrouter", "moonshotai/kimi-k2.5")];
    const entries = [slimEntry("kimi-k2.5", aggs, ["kimi-k2-5"])];

    const client = createCatalogClient({
      getModelByIdFromFirebase: mock(async () => null),
      readSlimCache: () => freshCache(entries),
    });

    const result = await client.vendorsForModel("kimi-k2-5");
    expect(result).toEqual(aggs);
  });

  test("returns null for unknown model when cache is fresh", async () => {
    const fakeFirebaseLookup = mock(async () => null);
    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => freshCache([slimEntry("gpt-5", [])]),
    });

    const result = await client.vendorsForModel("nonexistent-model-xyz");
    expect(result).toBeNull();
    // Fresh cache + miss → don't bother Firebase.
    expect(fakeFirebaseLookup).not.toHaveBeenCalled();
  });

  test("stale cache + cache miss falls back to Firebase lookup", async () => {
    const fbAggs = [aggregator("openrouter", "vendor/late-arrival")];
    const fakeFirebaseLookup = mock(async (modelId: string) => {
      expect(modelId).toBe("late-arrival");
      return modelDoc("late-arrival", "vendor", { aggregators: fbAggs });
    });

    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => staleCache([]),
    });

    const result = await client.vendorsForModel("late-arrival");
    expect(result).toEqual(fbAggs);
    expect(fakeFirebaseLookup).toHaveBeenCalledTimes(1);
  });

  test("stale cache hit short-circuits Firebase lookup", async () => {
    // Even when stale, an in-cache match is preferable to a network call —
    // the cache is good enough for routing decisions until a refresh runs.
    const aggs = [aggregator("anthropic", "claude-opus-4-7")];
    const fakeFirebaseLookup = mock(async () => null);
    const client = createCatalogClient({
      getModelByIdFromFirebase: fakeFirebaseLookup,
      readSlimCache: () => staleCache([slimEntry("claude-opus-4-7", aggs)]),
    });

    const result = await client.vendorsForModel("claude-opus-4-7");
    expect(result).toEqual(aggs);
    expect(fakeFirebaseLookup).not.toHaveBeenCalled();
  });

  test("missing cache + Firebase miss returns null", async () => {
    const client = createCatalogClient({
      getModelByIdFromFirebase: mock(async () => null),
      readSlimCache: () => null,
    });

    const result = await client.vendorsForModel("ghost");
    expect(result).toBeNull();
  });
});

// ─── searchModels ────────────────────────────────────────────────────────────

describe("searchModels", () => {
  test("delegates to Firebase searchModels with the given term", async () => {
    const fakeSearch = mock(async (_term: string, _limit?: number) => [
      modelDoc("claude-opus-4-7", "anthropic"),
      modelDoc("claude-sonnet-4-5", "anthropic"),
    ]);
    const client = createCatalogClient({ searchModels: fakeSearch });

    const result = await client.searchModels("claude");

    expect(fakeSearch).toHaveBeenCalledTimes(1);
    expect(fakeSearch.mock.calls[0]?.[0]).toBe("claude");
    expect(result).toHaveLength(2);
    expect(result[0]?.modelId).toBe("claude-opus-4-7");
  });

  test("propagates the explicit limit argument", async () => {
    const fakeSearch = mock(async (_term: string, _limit?: number) => []);
    const client = createCatalogClient({ searchModels: fakeSearch });

    await client.searchModels("gpt", 10);

    expect(fakeSearch.mock.calls[0]?.[1]).toBe(10);
  });

  test("default limit is 50 when not specified", async () => {
    const fakeSearch = mock(async (_term: string, _limit?: number) => []);
    const client = createCatalogClient({ searchModels: fakeSearch });

    await client.searchModels("anything");

    expect(fakeSearch.mock.calls[0]?.[1]).toBe(50);
  });
});
