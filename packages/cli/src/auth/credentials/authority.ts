/**
 * CredentialAuthority — the single registry/dispatch point for credentials.
 *
 * The single ASYNC source of truth for provider credentials. proxy-server
 * (sign-time getRequestAuth), routing-rules (hasCredentialsForProvider), the
 * model-selector/index readiness checks, provider-resolver, and the OAuth
 * transports all consume it; the old per-entry-point env-push paths
 * (loadStoredApiKeys/hydrateOpSecrets/applyCustomEndpointOpKeys) are gone.
 * Registering a provider under multiple names (aliases) lets the catalog's
 * alternate slugs (e.g. "google" → the Gemini Code Assist credential) resolve
 * to the same instance.
 */

import { BUILTIN_PROVIDERS } from "../../providers/provider-definitions.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { makeCodexCredential } from "./codex-credential.js";
import { GeminiCodeAssistCredentialProvider } from "./gemini-credential.js";
import { makeKimiCodingCredential, makeKimiCredential } from "./kimi-credential.js";
import { LocalCredentialProvider } from "./local-credential.js";
import { NativeAnthropicCredentialProvider } from "./native-anthropic-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";
import { VertexCredentialProvider } from "./vertex-credential.js";

/** Built-in local provider names that get a LocalCredentialProvider. */
const LOCAL_PROVIDER_NAMES = ["ollama", "lmstudio", "vllm", "mlx"];

export class CredentialAuthority {
  private registry = new Map<string, CredentialProvider>();

  register(p: CredentialProvider, aliases: string[] = []): void {
    this.registry.set(p.catalogName, p);
    for (const a of aliases) {
      this.registry.set(a, p);
    }
  }

  /**
   * Register (or replace) a plain API-key provider at RUNTIME — used by custom
   * endpoints, which are loaded after this singleton is built. Idempotent: a
   * re-register with the same name overwrites. This keeps custom endpoints
   * inside the single authority instead of resolving their keys out-of-band.
   */
  registerApiKeyProvider(descriptor: {
    name: string;
    envVar: string;
    aliases?: string[];
    authScheme?: "bearer" | "x-api-key";
  }): void {
    if (!descriptor.envVar) return;
    this.register(
      new ApiKeyCredentialProvider({
        catalogName: descriptor.name,
        envVar: descriptor.envVar,
        aliases: descriptor.aliases,
        authScheme: descriptor.authScheme === "x-api-key" ? "x-api-key" : "bearer",
      }),
      [descriptor.name]
    );
  }

  /**
   * ASYNC readiness: resolves env → config → oauth-file → op:// (lazy SDK) for
   * the provider. Never throws — an unknown provider or a 1Password auth failure
   * resolves to false. Memoized inside each provider, so the SDK is touched at
   * most once. This is THE single readiness oracle (replaces the three old sync
   * ones: isProviderAvailable / isApiKeyAvailable / the old isAuthenticated).
   */
  async isAvailable(name: string, opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    try {
      return (await this.registry.get(name)?.isAvailable(opts)) ?? false;
    } catch {
      return false;
    }
  }

  async getRequestAuth(name: string, ctx: RequestAuthContext): Promise<RequestAuth> {
    const p = this.registry.get(name);
    if (!p) throw new Error(`No credential provider for ${name}`);
    return p.getRequestAuth(ctx);
  }

  /**
   * Drop any memoized resolution. With no name, invalidate every registered
   * provider (after a TUI hydrate-on-add or a config change). Idempotent.
   */
  invalidate(name?: string): void {
    if (name) {
      this.registry.get(name)?.invalidate?.();
      return;
    }
    // Dedup: providers registered under aliases share one instance.
    const seen = new Set<CredentialProvider>();
    for (const p of this.registry.values()) {
      if (seen.has(p)) continue;
      seen.add(p);
      p.invalidate?.();
    }
  }

  async login(name: string): Promise<void> {
    await this.registry.get(name)?.login?.();
  }

  async logout(name: string): Promise<void> {
    await this.registry.get(name)?.logout?.();
  }

  get(name: string): CredentialProvider | undefined {
    return this.registry.get(name);
  }

  static buildDefault(): CredentialAuthority {
    const authority = new CredentialAuthority();

    // Explicitly-handled providers (OAuth / composite / ADC / local / native).
    authority.register(makeCodexCredential(), ["openai-codex"]);
    authority.register(new GeminiCodeAssistCredentialProvider(), ["gemini-codeassist", "google"]);
    authority.register(makeKimiCredential(), ["kimi"]);
    // kimi-coding is a SEPARATE product with its own endpoint + KIMI_CODING_API_KEY.
    // It must NOT alias onto the regular Kimi credential, or the coding endpoint
    // receives the wrong product's key → 401.
    authority.register(makeKimiCodingCredential(), ["kimi-coding"]);
    authority.register(new VertexCredentialProvider(), ["vertex"]);
    for (const name of LOCAL_PROVIDER_NAMES) {
      authority.register(new LocalCredentialProvider(name), [name]);
    }
    authority.register(new NativeAnthropicCredentialProvider(), ["native-anthropic"]);

    // Names already owned by the explicit registrations above — never override
    // them with a generic API-key provider.
    const alreadyRegistered = new Set<string>([
      "openai-codex",
      "gemini-codeassist",
      "google",
      "kimi",
      "kimi-coding",
      "vertex",
      "native-anthropic",
      ...LOCAL_PROVIDER_NAMES,
    ]);

    // Every other builtin provider that has an API-key env var gets a plain
    // ApiKeyCredentialProvider. Local providers and OAuth-only providers (empty
    // apiKeyEnvVar) are skipped.
    for (const def of BUILTIN_PROVIDERS) {
      if (alreadyRegistered.has(def.name)) continue;
      if (def.isLocal) continue;
      if (!def.apiKeyEnvVar) continue;
      authority.register(
        new ApiKeyCredentialProvider({
          catalogName: def.name,
          envVar: def.apiKeyEnvVar,
          aliases: def.apiKeyAliases,
          authScheme: def.authScheme === "x-api-key" ? "x-api-key" : "bearer",
          // Mirror the readiness affordances the old isProviderAvailable oracle
          // granted, so authority.isAuthenticated() matches hasCredentialsForProvider.
          publicKeyFallback: !!def.publicKeyFallback,
          oauthFallback: def.oauthFallback,
        }),
        [def.name]
      );
    }

    return authority;
  }
}

export const credentials = CredentialAuthority.buildDefault();
