/**
 * Tests for provider-definitions.ts — single source of truth for provider identity.
 *
 * Run: bun test packages/cli/src/providers/provider-definitions.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PROVIDERS,
  getApiKeyEnvVars,
  getApiKeyInfo,
  getDisplayName,
  getEffectiveBaseUrl,
  getLegacyPrefixPatterns,
  getNativeModelPatterns,
  getProviderByName,
  getShortcuts,
  getShortestPrefix,
  toRemoteProvider,
} from "./provider-definitions.js";

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

describe("BUILTIN_PROVIDERS structural integrity", () => {
  // REGRESSION: the Sakana SUBSCRIPTION plan (sc@ / sakana-subscription) bills
  // against a SEPARATE key from the pay-as-you-go API (sakana / SAKANA_API_KEY).
  // Its primary env var is SAKANA_SUBSCRIPTION_API_KEY (named after Sakana's own
  // "subscription" term, not "coding" — the plan is general-purpose). It must
  // NOT alias back to SAKANA_API_KEY — doing so made sc@ silently use the PAYG
  // key and bill prepaid credits ("Prepaid credit balance is exhausted") despite
  // an active subscription.
  test("sakana-subscription uses its own key, not the pay-as-you-go SAKANA_API_KEY", () => {
    const sub = BUILTIN_PROVIDERS.find((d) => d.name === "sakana-subscription");
    expect(sub).toBeDefined();
    expect(sub!.apiKeyEnvVar).toBe("SAKANA_SUBSCRIPTION_API_KEY");
    // Old name kept only as a back-compat alias.
    expect(sub!.apiKeyAliases ?? []).toContain("SAKANA_CODING_API_KEY");
    // The dangerous PAYG alias must NOT be present.
    expect(sub!.apiKeyAliases ?? []).not.toContain("SAKANA_API_KEY");
    // The old provider name is fully gone.
    expect(BUILTIN_PROVIDERS.find((d) => d.name === "sakana-coding")).toBeUndefined();
    // Sibling subscription plans also keep their key isolated from PAYG.
    const kimiCoding = BUILTIN_PROVIDERS.find((d) => d.name === "kimi-coding");
    expect(kimiCoding!.apiKeyAliases ?? []).not.toContain("MOONSHOT_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// getShortcuts
// ---------------------------------------------------------------------------

describe("getShortcuts", () => {
  const shortcuts = getShortcuts();

  test("maps 'g' to 'google'", () => {
    expect(shortcuts.g).toBe("google");
  });

  test("maps 'gemini' to 'google'", () => {
    expect(shortcuts.gemini).toBe("google");
  });

  test("maps 'oai' to 'openai'", () => {
    expect(shortcuts.oai).toBe("openai");
  });

  test("maps 'or' to 'openrouter'", () => {
    expect(shortcuts.or).toBe("openrouter");
  });

  test("maps 'mm' to 'minimax'", () => {
    expect(shortcuts.mm).toBe("minimax");
  });

  test("maps 'kimi' to 'kimi'", () => {
    expect(shortcuts.kimi).toBe("kimi");
  });

  test("maps 'glm' to 'glm'", () => {
    expect(shortcuts.glm).toBe("glm");
  });

  test("maps local provider shortcuts", () => {
    expect(shortcuts.ollama).toBe("ollama");
    expect(shortcuts.lms).toBe("lmstudio");
    expect(shortcuts.vllm).toBe("vllm");
    expect(shortcuts.mlx).toBe("mlx");
  });

  test("maps 'poe' to 'poe'", () => {
    expect(shortcuts.poe).toBe("poe");
  });

  test("maps 'litellm' to 'litellm'", () => {
    expect(shortcuts.litellm).toBe("litellm");
    expect(shortcuts.ll).toBe("litellm");
  });
});

// ---------------------------------------------------------------------------
// getLegacyPrefixPatterns
// ---------------------------------------------------------------------------

describe("getLegacyPrefixPatterns", () => {
  const patterns = getLegacyPrefixPatterns();

  test("includes 'g/' for google", () => {
    const gPattern = patterns.find((p) => p.prefix === "g/");
    expect(gPattern).toBeDefined();
    expect(gPattern!.provider).toBe("google");
    expect(gPattern!.stripPrefix).toBe(true);
  });

  test("includes local provider prefixes", () => {
    const ollamaSlash = patterns.find((p) => p.prefix === "ollama/");
    expect(ollamaSlash).toBeDefined();
    expect(ollamaSlash!.provider).toBe("ollama");

    const ollamaColon = patterns.find((p) => p.prefix === "ollama:");
    expect(ollamaColon).toBeDefined();
    expect(ollamaColon!.provider).toBe("ollama");
  });
});

// ---------------------------------------------------------------------------
// getNativeModelPatterns
// ---------------------------------------------------------------------------

describe("getNativeModelPatterns", () => {
  const patterns = getNativeModelPatterns();

  test("gemini-* matches google", () => {
    const match = patterns.find((p) => p.pattern.test("gemini-2.0-flash"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("google");
  });

  test("gpt-* matches openai", () => {
    const match = patterns.find((p) => p.pattern.test("gpt-4o"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("openai");
  });

  test("kimi-for-coding matches kimi-coding (before general kimi-*)", () => {
    const match = patterns.find((p) => p.pattern.test("kimi-for-coding"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("kimi-coding");
  });

  test("kimi-k2 matches kimi", () => {
    const match = patterns.find((p) => p.pattern.test("kimi-k2"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("kimi");
  });

  test("claude-3-opus matches native-anthropic", () => {
    const match = patterns.find((p) => p.pattern.test("claude-3-opus-20240229"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("native-anthropic");
  });

  test("qwen matches qwen", () => {
    const match = patterns.find((p) => p.pattern.test("qwen3-coder-next"));
    expect(match).toBeDefined();
    expect(match!.provider).toBe("qwen");
  });
});

// ---------------------------------------------------------------------------
// getProviderByName
// ---------------------------------------------------------------------------

describe("getProviderByName", () => {
  test("finds google", () => {
    const def = getProviderByName("google");
    expect(def).toBeDefined();
    expect(def!.displayName).toBe("Gemini");
  });

  test("returns undefined for unknown provider", () => {
    expect(getProviderByName("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getApiKeyInfo
// ---------------------------------------------------------------------------

describe("getApiKeyInfo", () => {
  test("returns correct info for google", () => {
    const info = getApiKeyInfo("google");
    expect(info).toBeDefined();
    expect(info!.envVar).toBe("GEMINI_API_KEY");
    expect(info!.url).toContain("aistudio.google.com");
  });

  test("returns aliases for kimi", () => {
    const info = getApiKeyInfo("kimi");
    expect(info).toBeDefined();
    expect(info!.aliases).toContain("KIMI_API_KEY");
  });

  test("returns oauthFallback for kimi-coding", () => {
    const info = getApiKeyInfo("kimi-coding");
    expect(info).toBeDefined();
    expect(info!.oauthFallback).toBe("kimi-oauth.json");
  });

  test("returns null for unknown provider", () => {
    expect(getApiKeyInfo("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDisplayName
// ---------------------------------------------------------------------------

describe("getDisplayName", () => {
  test("capitalizes unknown provider names", () => {
    expect(getDisplayName("unknown")).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// getEffectiveBaseUrl
// ---------------------------------------------------------------------------

describe("getEffectiveBaseUrl", () => {
  test("returns base URL for provider without env overrides", () => {
    const def = getProviderByName("openrouter")!;
    expect(getEffectiveBaseUrl(def)).toBe("https://openrouter.ai");
  });
});

// ---------------------------------------------------------------------------
// isLocalTransport / isDirectApiProvider
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// toRemoteProvider
// ---------------------------------------------------------------------------

describe("toRemoteProvider", () => {
  test("google maps to 'gemini' for RemoteProvider.name (backwards compat)", () => {
    const def = getProviderByName("google")!;
    const rp = toRemoteProvider(def);
    expect(rp.name).toBe("gemini");
  });

  test("preserves custom headers", () => {
    const def = getProviderByName("openrouter")!;
    const rp = toRemoteProvider(def);
    expect(rp.headers).toBeDefined();
    expect(rp.headers!["HTTP-Referer"]).toBe("https://claudish.com");
  });

  test("preserves authScheme", () => {
    const def = getProviderByName("minimax")!;
    const rp = toRemoteProvider(def);
    expect(rp.authScheme).toBe("bearer");
  });
});

// ---------------------------------------------------------------------------
// getShortestPrefix / getApiKeyEnvVars
// ---------------------------------------------------------------------------

describe("getShortestPrefix", () => {
  test("falls back to provider name for unknown", () => {
    expect(getShortestPrefix("unknown")).toBe("unknown");
  });
});

describe("getApiKeyEnvVars", () => {
  test("returns env var info for known providers", () => {
    const info = getApiKeyEnvVars("google");
    expect(info).toBeDefined();
    expect(info!.envVar).toBe("GEMINI_API_KEY");
  });

  test("returns aliases when available", () => {
    const info = getApiKeyEnvVars("kimi");
    expect(info).toBeDefined();
    expect(info!.aliases).toContain("KIMI_API_KEY");
  });

  test("returns null for unknown provider", () => {
    expect(getApiKeyEnvVars("nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isProviderAvailable / isProviderAvailableByName were DELETED in the
// async-credential-layer refactor — provider readiness now lives in the
// credential authority (auth/credentials/authority.ts → isAvailable). The
// readiness cases formerly tested here (local always-available, publicKeyFallback,
// primary key, alias key, no-key → unavailable) are covered by the authority's
// equivalence matrix in auth/credentials/equivalence.test.ts.
