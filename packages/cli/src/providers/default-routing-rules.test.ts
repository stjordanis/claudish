/**
 * Unit tests for providers/default-routing-rules.ts
 *
 * Verifies that the shipped DEFAULT_ROUTING_RULES table:
 *   - matches the patterns the migration plan §B.1 documents,
 *   - feeds correctly through matchRoutingRule + buildRoutingChain,
 *   - validates cleanly against provider-definitions.ts.
 *
 * These tests do not touch the disk or env — pure data assertions.
 *
 * Run: bun test packages/cli/src/providers/default-routing-rules.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROUTING_RULES,
  validateDefaultRoutingRules,
  validateRoutingRulesAgainstProviders,
} from "./default-routing-rules.js";
import { buildRoutingChain, matchRoutingRule } from "./routing-rules.js";

// ---------------------------------------------------------------------------
// Pattern matching against the shipped rules
// ---------------------------------------------------------------------------

describe("DEFAULT_ROUTING_RULES pattern matching", () => {
  test("'claude-opus-4-7' matches claude-* → [native-anthropic, openrouter]", () => {
    const matched = matchRoutingRule("claude-opus-4-7", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["native-anthropic", "openrouter"]);
  });

  test("'gpt-5' matches gpt-* → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("gpt-5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'o1-mini' matches o1-* → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("o1-mini", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'o3-pro' matches o3-* → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("o3-pro", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'gemini-2.0-flash' matches gemini-* → [gemini-codeassist, google, openrouter]", () => {
    const matched = matchRoutingRule("gemini-2.0-flash", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["gemini-codeassist", "google", "openrouter"]);
  });

  test("'grok-4' matches grok-* → [x-ai, openrouter]", () => {
    const matched = matchRoutingRule("grok-4", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["x-ai", "openrouter"]);
  });

  test("'kimi-k2.5' matches kimi-* → [kimi-coding@kimi-for-coding, kimi, openrouter]", () => {
    const matched = matchRoutingRule("kimi-k2.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["kimi-coding@kimi-for-coding", "kimi", "openrouter"]);
  });

  test("kimi-* @model rewrite reaches buildRoutingChain correctly", () => {
    const matched = matchRoutingRule("kimi-k2.5", DEFAULT_ROUTING_RULES);
    expect(matched).not.toBeNull();
    const routes = buildRoutingChain(matched!, "kimi-k2.5");
    expect(routes).toHaveLength(3);
    // First entry uses kimi-coding's prefix and the rewritten model name
    expect(routes[0].provider).toBe("kimi-coding");
    expect(routes[0].modelSpec).toBe("kc@kimi-for-coding");
    // Second entry inherits original model name on direct kimi
    expect(routes[1].provider).toBe("kimi");
    expect(routes[1].modelSpec).toBe("kimi@kimi-k2.5");
  });

  test("'minimax-m2.5' matches minimax-* → [minimax-coding, minimax, openrouter]", () => {
    const matched = matchRoutingRule("minimax-m2.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["minimax-coding", "minimax", "openrouter"]);
  });

  // Case-insensitive matching: docs use mixed casing (`MiniMax-M2.5`,
  // `GPT-4o`); the rule keys are lowercase but matchRoutingRule lowers both
  // sides before comparing.
  test("'MiniMax-M2.5' matches minimax-* (case-insensitive) → [minimax-coding, minimax, openrouter]", () => {
    const matched = matchRoutingRule("MiniMax-M2.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["minimax-coding", "minimax", "openrouter"]);
  });

  test("'GPT-4o' matches gpt-* (case-insensitive) → [openai-codex, openai, openrouter]", () => {
    const matched = matchRoutingRule("GPT-4o", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openai-codex", "openai", "openrouter"]);
  });

  test("'Gemini-2.5-Pro' matches gemini-* (case-insensitive) → [gemini-codeassist, google, openrouter]", () => {
    const matched = matchRoutingRule("Gemini-2.5-Pro", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["gemini-codeassist", "google", "openrouter"]);
  });

  test("'glm-4.6' matches glm-* → [glm-coding, glm, openrouter]", () => {
    const matched = matchRoutingRule("glm-4.6", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["glm-coding", "glm", "openrouter"]);
  });

  test("'z-ai-glm-4.6' matches z-ai-* → [z-ai, openrouter]", () => {
    const matched = matchRoutingRule("z-ai-glm-4.6", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["z-ai", "openrouter"]);
  });

  test("'deepseek-v3.5' matches deepseek-* → [deepseek, openrouter]", () => {
    const matched = matchRoutingRule("deepseek-v3.5", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["deepseek", "openrouter"]);
  });

  test("'something-zen' matches *-zen → [opencode-zen]", () => {
    const matched = matchRoutingRule("something-zen", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["opencode-zen"]);
  });

  test("'random-unknown-model' falls through to '*' → [openrouter]", () => {
    const matched = matchRoutingRule("random-unknown-model", DEFAULT_ROUTING_RULES);
    expect(matched).toEqual(["openrouter"]);
  });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe("validateDefaultRoutingRules", () => {
  test("does NOT throw with the shipped rules", () => {
    expect(() => validateDefaultRoutingRules()).not.toThrow();
  });

  test("throws when a rule references an unknown provider", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "fake-*": ["totally-not-a-real-provider"],
      })
    ).toThrow(/unknown providers/);
  });

  test("throws and lists all unknown providers when multiple typos exist", () => {
    let err: Error | null = null;
    try {
      validateRoutingRulesAgainstProviders({
        "a-*": ["typo-one"],
        "b-*": ["typo-two", "openrouter"],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("typo-one");
    expect(err!.message).toContain("typo-two");
    // Real provider should not appear in the error
    expect(err!.message).not.toContain('→ unknown provider "openrouter"');
  });

  test("accepts provider@model rewrite syntax — only validates the provider portion", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "kimi-*": ["kimi-coding@whatever-model-name", "kimi"],
      })
    ).not.toThrow();
  });

  test("accepts provider shortcuts (e.g. 'or' resolves to 'openrouter')", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "*": ["or"],
      })
    ).not.toThrow();
  });

  test("rejects a typo in the provider portion of a provider@model rewrite", () => {
    expect(() =>
      validateRoutingRulesAgainstProviders({
        "kimi-*": ["typo-coding@kimi-for-coding"],
      })
    ).toThrow(/typo-coding/);
  });
});

// ---------------------------------------------------------------------------
// Shape of the rules table
// ---------------------------------------------------------------------------

describe("DEFAULT_ROUTING_RULES shape", () => {
  test("has a catch-all '*' entry", () => {
    expect(DEFAULT_ROUTING_RULES["*"]).toBeDefined();
  });

  test("every rule has a non-empty entry list", () => {
    for (const entries of Object.values(DEFAULT_ROUTING_RULES)) {
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
      // Sanity: entries must be non-empty strings
      for (const entry of entries) {
        expect(typeof entry).toBe("string");
        expect(entry.length).toBeGreaterThan(0);
      }
    }
  });
});
