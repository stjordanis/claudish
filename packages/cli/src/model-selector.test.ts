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
  buildExplicitModelSpec,
  isUserDeployedProvider,
  pickerProviderToFirebaseSlug,
} from "./model-selector.js";
import { createCatalogClient } from "./providers/model-catalog.js";

// ─── pickerProviderToFirebaseSlug ────────────────────────────────────────────

describe("pickerProviderToFirebaseSlug", () => {
  test.each([
    // Picker value          → Firebase aggregator/owner slug
    ["openrouter", "openrouter"],
    ["google", "google"],
    ["gemini-codeassist", "google"], // subscription routes through owner catalog
    ["openai", "openai"],
    ["openai-codex", "openai"], // subscription routes through owner catalog
    ["x-ai", "x-ai"],
    ["deepseek", "deepseek"],
    ["minimax", "minimax"],
    ["minimax-coding", "minimax"],
    ["kimi", "moonshotai"],
    ["kimi-coding", "moonshotai"],
    ["glm", "z-ai"],
    ["glm-coding", "z-ai"],
    ["z-ai", "z-ai"],
    ["zen", "opencode-zen"], // <-- the original bug: picker value "zen" must map cleanly
    ["opencode-zen", "opencode-zen"],
    ["opencode-zen-go", "opencode-zen-go"],
    ["ollamacloud", "ollamacloud"],
  ])("maps picker value %p → Firebase slug %p", (pickerValue, firebaseSlug) => {
    expect(pickerProviderToFirebaseSlug[pickerValue]).toBe(firebaseSlug);
  });

  test("does not map LiteLLM / Ollama / LM Studio (those are free-text providers)", () => {
    expect(pickerProviderToFirebaseSlug.litellm).toBeUndefined();
    expect(pickerProviderToFirebaseSlug.ollama).toBeUndefined();
    expect(pickerProviderToFirebaseSlug.lmstudio).toBeUndefined();
  });
});

// ─── isUserDeployedProvider ──────────────────────────────────────────────────

describe("isUserDeployedProvider", () => {
  test.each([["litellm"], ["ollama"], ["lmstudio"]])(
    "%p is treated as user-deployed (free-text input branch)",
    (value) => {
      expect(isUserDeployedProvider(value)).toBe(true);
    }
  );

  test.each([
    ["openrouter"],
    ["zen"],
    ["google"],
    ["openai"],
    ["openai-codex"],
    ["x-ai"],
    ["minimax"],
    ["kimi"],
    ["glm"],
    ["z-ai"],
    ["ollamacloud"], // cloud-hosted; Firebase has the catalog
  ])("%p is NOT user-deployed", (value) => {
    expect(isUserDeployedProvider(value)).toBe(false);
  });
});

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
          aggregators: [{ provider: "x-ai", externalId: "grok-4", confidence: "api_official" as const }],
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
