/**
 * Tests for native Anthropic model detection used in claude-runner.ts.
 * When model mappings include native claude-* models, claudish must preserve
 * real subscription credentials instead of setting placeholder tokens.
 */

import { describe, expect, test } from "bun:test";
import { parseModelSpec } from "./providers/model-parser.js";

describe("Native Anthropic mapping detection", () => {
  describe("parseModelSpec identifies native claude models", () => {
    // Two structurally-distinct shapes cover the whole /^claude-/i match:
    // a modern family-before-version name and a legacy version-before-family
    // name with a date suffix. Everything after "claude-" is inert to the regex.
    test("current name: claude-opus-4-6", () => {
      expect(parseModelSpec("claude-opus-4-6").provider).toBe("native-anthropic");
    });

    test("legacy name with date suffix: claude-3-opus-20240229", () => {
      expect(parseModelSpec("claude-3-opus-20240229").provider).toBe("native-anthropic");
    });

    // Explicit anthropic/ prefix
    test("anthropic/claude-sonnet-4-6", () => {
      expect(parseModelSpec("anthropic/claude-sonnet-4-6").provider).toBe("native-anthropic");
    });
  });

  describe("non-native models are NOT native-anthropic", () => {
    test("grok via slash prefix", () => {
      expect(parseModelSpec("x-ai/grok-code-fast-1").provider).not.toBe("native-anthropic");
    });

    test("gemini via @ syntax", () => {
      expect(parseModelSpec("google@gemini-2.5-pro").provider).not.toBe("native-anthropic");
    });

    test("openrouter@ claude routes to openrouter, not native", () => {
      expect(parseModelSpec("openrouter@anthropic/claude-3.5-sonnet").provider).toBe("openrouter");
    });
  });
});
