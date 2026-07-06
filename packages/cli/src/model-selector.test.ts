/**
 * Tests for the pure-logic helpers in `model-selector.ts`.
 *
 * The inquirer-driven flows are end-to-end tested via the headless tmux smoke
 * run in commit 3 (see `ai-docs/sessions/.../commit-3-summary.md`). Here we
 * focus on the parts that are at risk of silent regression — the picker
 * provider→Firebase slug map, the user-deployed predicate, and the model-spec
 * builder.
 *
 * Run: bun test packages/cli/src/model-selector.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import {
  type ModelInfo,
  buildExplicitModelSpec,
  pickerProviderToFirebaseSlug,
  resolveProviderDisplayPrice,
  resolveProviderExternalId,
} from "./model-selector.js";
import { createCatalogClient } from "./providers/model-catalog.js";

// ─── pickerProviderToFirebaseSlug ────────────────────────────────────────────

// ─── isUserDeployedProvider ──────────────────────────────────────────────────

// ─── buildExplicitModelSpec ──────────────────────────────────────────────────

describe("buildExplicitModelSpec", () => {
  test.each([
    ["zen", "claude-opus-4-7", "zen@claude-opus-4-7"],
    ["openrouter", "qwen/qwen3-coder", "openrouter@qwen/qwen3-coder"],
    ["google", "gemini-2.5-pro", "google@gemini-2.5-pro"],
    ["openai", "gpt-5", "oai@gpt-5"],
    ["openai-codex", "gpt-5-codex", "cx@gpt-5-codex"],
    ["x-ai", "grok-4", "x-ai@grok-4"],
    ["deepseek", "deepseek-v3", "ds@deepseek-v3"],
    ["minimax", "MiniMax-M2", "mm@MiniMax-M2"],
    ["minimax-coding", "MiniMax-M2", "mmc@MiniMax-M2"],
    ["kimi", "kimi-k2", "kimi@kimi-k2"],
    ["kimi-coding", "kimi-for-coding", "kc@kimi-for-coding"],
    // gemini-codeassist renders google-catalog rows in the picker; without a
    // prefix entry, rows would emit a bare id that won't route to Code Assist.
    ["gemini-codeassist", "gemini-3-pro", "go@gemini-3-pro"],
    ["glm", "glm-4-plus", "glm@glm-4-plus"],
    ["glm-coding", "glm-4-plus", "gc@glm-4-plus"],
    ["z-ai", "z-ai-plus", "z-ai@z-ai-plus"],
    ["ollamacloud", "llama-3.1-70b", "oc@llama-3.1-70b"],
    ["ollama", "llama3.2", "ollama@llama3.2"],
    ["lmstudio", "qwen2.5-7b", "lmstudio@qwen2.5-7b"],
  ])("builds %s + %s → %s", (provider, modelId, expected) => {
    expect(buildExplicitModelSpec(provider, modelId)).toBe(expected);
  });

  test("does not double-prefix when model ID already starts with the provider prefix", () => {
    expect(buildExplicitModelSpec("zen", "zen@gpt-5")).toBe("zen@gpt-5");
    expect(buildExplicitModelSpec("openrouter", "openrouter@anthropic/claude-opus-4-7")).toBe(
      "openrouter@anthropic/claude-opus-4-7"
    );
  });

  test("returns model ID unchanged when provider has no prefix entry", () => {
    expect(buildExplicitModelSpec("unknown-provider", "some-model")).toBe("some-model");
  });
});

// ─── resolveProviderExternalId (exact callable-spec rendering) ───────────────

describe("resolveProviderExternalId", () => {
  // gpt-5 is served bare by OpenAI but vendor-prefixed by OpenRouter / Zen.
  const gpt5: ModelInfo = {
    id: "gpt-5",
    name: "GPT-5",
    description: "",
    provider: "OpenAI",
    aggregators: [
      { provider: "openai", externalId: "gpt-5", confidence: "api_official" },
      { provider: "openrouter", externalId: "openai/gpt-5", confidence: "gateway_official" },
      { provider: "opencode-zen", externalId: "openai/gpt-5", confidence: "gateway_official" },
    ],
  };

  test("OpenRouter row uses the vendor-prefixed externalId", () => {
    // → or@openai/gpt-5
    expect(resolveProviderExternalId("openrouter", gpt5)).toBe("openai/gpt-5");
    expect(
      buildExplicitModelSpec("openrouter", resolveProviderExternalId("openrouter", gpt5))
    ).toBe("openrouter@openai/gpt-5");
  });

  test("OpenAI row uses the bare externalId", () => {
    // → oai@gpt-5
    expect(resolveProviderExternalId("openai", gpt5)).toBe("gpt-5");
    expect(buildExplicitModelSpec("openai", resolveProviderExternalId("openai", gpt5))).toBe(
      "oai@gpt-5"
    );
  });

  test("Zen row uses whatever externalId the catalog stores for opencode-zen", () => {
    // The catalog currently stores "openai/gpt-5" for Zen; we render exactly
    // that so the displayed spec is the true callable id (zen@openai/gpt-5).
    expect(resolveProviderExternalId("zen", gpt5)).toBe("openai/gpt-5");
  });

  test("falls back to the bare model id when no aggregator matches the provider", () => {
    const noAgg: ModelInfo = {
      id: "llama3.2:3b",
      name: "llama",
      description: "",
      provider: "Ollama",
    };
    expect(resolveProviderExternalId("ollama", noAgg)).toBe("llama3.2:3b");
    // A provider with aggregators but none for the selected provider also falls back.
    expect(resolveProviderExternalId("deepseek", gpt5)).toBe("gpt-5");
  });
});

// ─── resolveProviderDisplayPrice (true per-aggregator pricing) ───────────────

describe("resolveProviderDisplayPrice", () => {
  // gpt-5: owner OpenAI lists $1.25/$10; aggregators charge their OWN rates.
  // The slim catalog now carries per-aggregator pricing on each entry.
  const gpt5: ModelInfo = {
    id: "gpt-5",
    name: "GPT-5",
    description: "",
    provider: "OpenAI",
    pricing: { input: "$1.25", output: "$10.00", average: "$5.63/1M" },
    aggregators: [
      {
        provider: "openai",
        externalId: "gpt-5",
        confidence: "api_official",
        pricing: { input: 1.25, output: 10 },
      },
      {
        provider: "openrouter",
        externalId: "openai/gpt-5",
        confidence: "gateway_official",
        pricing: { input: 1.3, output: 10.5 }, // marked-up gateway rate
      },
      {
        provider: "opencode-zen",
        externalId: "openai/gpt-5",
        confidence: "gateway_official",
        pricing: { input: 1.07, output: 8.5 }, // cheaper gateway rate
      },
    ],
  };

  test("shows the selected aggregator's TRUE per-gateway price, not the owner price", () => {
    // OpenRouter: ($1.30 + $10.50)/2 = $5.90/1M
    expect(resolveProviderDisplayPrice("openrouter", gpt5)).toBe("$5.90/1M");
    // OpenCode Zen: ($1.07 + $8.50)/2 = $4.79/1M (different from OpenRouter — the point)
    expect(resolveProviderDisplayPrice("zen", gpt5)).toBe("$4.79/1M");
    // OpenAI (owner): ($1.25 + $10)/2 = $5.63/1M
    expect(resolveProviderDisplayPrice("openai", gpt5)).toBe("$5.63/1M");
  });

  test("falls back to model-level price when the aggregator entry has no pricing", () => {
    const noEntryPrice: ModelInfo = {
      id: "m",
      name: "m",
      description: "",
      provider: "OpenAI",
      pricing: { input: "$1.00", output: "$2.00", average: "$1.50/1M" },
      aggregators: [
        // openrouter entry exists but carries NO pricing → fall back to model.pricing
        { provider: "openrouter", externalId: "x/m", confidence: "gateway_official" },
      ],
    };
    expect(resolveProviderDisplayPrice("openrouter", noEntryPrice)).toBe("$1.50/1M");
  });

  test("returns N/A when neither aggregator nor model pricing is known", () => {
    const noPrice: ModelInfo = {
      id: "m",
      name: "m",
      description: "",
      provider: "OpenAI",
      aggregators: [{ provider: "openrouter", externalId: "x/m", confidence: "gateway_official" }],
    };
    expect(resolveProviderDisplayPrice("openrouter", noPrice)).toBe("N/A");
  });
});

// ─── fixedModel single-model subscription providers (Kimi Coding) ────────────

// ─── CatalogClient integration: picker → modelsByVendor("opencode-zen") ──────

describe("CatalogClient integration for the original Zen bug", () => {
  test("modelsByVendor('opencode-zen') returns Zen-served models from the slim cache", async () => {
    // The picker for OpenCode Zen now flows: pick "OpenCode Zen" (value "zen") →
    // pickerProviderToFirebaseSlug["zen"] === "opencode-zen" →
    // catalog.modelsByVendor("opencode-zen") → slim-cache filter on
    // aggregators[].provider. This test verifies the data plumbing is intact
    // independent of the inquirer widgets.
    const fakeReadSlimCache = mock(() => ({
      version: 2 as const,
      lastUpdated: new Date().toISOString(),
      entries: [
        {
          modelId: "claude-opus-4-7",
          aliases: [],
          sources: {},
          aggregators: [
            {
              provider: "anthropic",
              externalId: "claude-opus-4-7",
              confidence: "api_official" as const,
            },
            {
              provider: "opencode-zen",
              externalId: "anthropic/claude-opus-4-7",
              confidence: "gateway_official" as const,
            },
          ],
        },
        {
          modelId: "gpt-5",
          aliases: [],
          sources: {},
          aggregators: [
            { provider: "openai", externalId: "gpt-5", confidence: "api_official" as const },
            {
              provider: "opencode-zen",
              externalId: "openai/gpt-5",
              confidence: "gateway_official" as const,
            },
          ],
        },
        {
          modelId: "grok-4",
          aliases: [],
          sources: {},
          aggregators: [
            { provider: "x-ai", externalId: "grok-4", confidence: "api_official" as const },
          ],
        },
      ],
      models: [],
    }));

    const fakeProviderQuery = mock(async () => []);
    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: fakeReadSlimCache,
    });

    const pickerValue = "zen";
    const firebaseSlug = pickerProviderToFirebaseSlug[pickerValue];
    expect(firebaseSlug).toBe("opencode-zen");

    const result = await client.modelsByVendor(firebaseSlug!);

    expect(result.map((m) => m.modelId).sort()).toEqual(["claude-opus-4-7", "gpt-5"]);
    // Aggregator path must not hit the rich provider query.
    expect(fakeProviderQuery).not.toHaveBeenCalled();
  });

  test("modelsByVendor('moonshotai') routes Kimi picker to the owner catalog", async () => {
    // pickerValue "kimi" → "moonshotai" (owner) → rich provider query.
    const fakeProviderQuery = mock(async (slug: string) => {
      expect(slug).toBe("moonshotai");
      return [
        {
          modelId: "kimi-k2",
          provider: "moonshotai",
          displayName: "Kimi K2",
        },
      ];
    });

    const client = createCatalogClient({
      getModelsByProvider: fakeProviderQuery,
      readSlimCache: () => null,
    });

    const firebaseSlug = pickerProviderToFirebaseSlug.kimi;
    expect(firebaseSlug).toBe("moonshotai");

    const result = await client.modelsByVendor(firebaseSlug!);

    expect(result).toHaveLength(1);
    expect(result[0]?.modelId).toBe("kimi-k2");
    expect(fakeProviderQuery).toHaveBeenCalledTimes(1);
  });
});
