import { describe, expect, test } from "bun:test";
import { resolveDefaultProvider } from "./default-provider.js";
import type { ClaudishProfileConfig } from "./profile-config.js";

function makeConfig(overrides: Partial<ClaudishProfileConfig> = {}): ClaudishProfileConfig {
  return {
    version: "1.0.0",
    defaultProfile: "default",
    profiles: {},
    ...overrides,
  };
}

describe("resolveDefaultProvider precedence", () => {
  test("CLI flag wins over env var, config, and legacy", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDISH_DEFAULT_PROVIDER: "from-env",
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
      OPENROUTER_API_KEY: "or-key",
    };
    const config = makeConfig({ defaultProvider: "from-config" });

    const result = resolveDefaultProvider({ cliFlag: "from-flag", config, env });

    expect(result.provider).toBe("from-flag");
    expect(result.source).toBe("cli-flag");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("env var wins over config and legacy", () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDISH_DEFAULT_PROVIDER: "from-env",
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
    };
    const config = makeConfig({ defaultProvider: "from-config" });

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("from-env");
    expect(result.source).toBe("env-var");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("config wins over legacy", () => {
    const env: NodeJS.ProcessEnv = {
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
    };
    const config = makeConfig({ defaultProvider: "from-config" });

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("from-config");
    expect(result.source).toBe("config-file");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("LITELLM env vars no longer auto-promote (commit 5: removed)", () => {
    // Pre-commit-5, having both LITELLM_BASE_URL and LITELLM_API_KEY set
    // would resolve provider="litellm" with source="legacy-litellm". After
    // commit 5 of the catalog/routing redesign, this auto-promotion is gone
    // — the resolver falls through to the next tier (OPENROUTER_API_KEY or
    // hardcoded). Users wanting LiteLLM as default must set defaultProvider
    // explicitly in config.json or via CLAUDISH_DEFAULT_PROVIDER.
    const env: NodeJS.ProcessEnv = {
      LITELLM_BASE_URL: "http://litellm.local",
      LITELLM_API_KEY: "key",
    };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("hardcoded");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("OPENROUTER_API_KEY fallback when no LITELLM", () => {
    const env: NodeJS.ProcessEnv = {
      OPENROUTER_API_KEY: "or-key",
    };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("openrouter-key");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("hardcoded openrouter when nothing set", () => {
    const env: NodeJS.ProcessEnv = {};
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("hardcoded");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("LITELLM_BASE_URL alone without LITELLM_API_KEY does not auto-promote", () => {
    const env: NodeJS.ProcessEnv = {
      LITELLM_BASE_URL: "http://litellm.local",
    };
    const config = makeConfig();

    const result = resolveDefaultProvider({ config, env });

    expect(result.provider).toBe("openrouter");
    expect(result.source).toBe("hardcoded");
    expect(result.legacyAutoPromoted).toBe(false);
  });

  test("empty CLI flag falls through (does not match)", () => {
    const env: NodeJS.ProcessEnv = { CLAUDISH_DEFAULT_PROVIDER: "from-env" };
    const config = makeConfig();

    const result = resolveDefaultProvider({ cliFlag: "", config, env });

    expect(result.provider).toBe("from-env");
    expect(result.source).toBe("env-var");
  });
});

describe("buildLegacyHint (commit 5: now a no-op)", () => {
  // Pre-commit-5, this returned a stderr hint when legacyAutoPromoted=true.
  // Since LiteLLM auto-promotion was removed, the function always returns
  // null — kept for backwards-compat with existing callers.
});
