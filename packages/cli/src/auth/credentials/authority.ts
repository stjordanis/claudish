/**
 * CredentialAuthority — the single registry/dispatch point for credentials.
 *
 * This is a PURE ADDITION (Step 1 of the credential-authority refactor). Nothing
 * else in the codebase consumes it yet; transports and the existing read sites
 * are migrated in later steps. Registering a provider under multiple names
 * (aliases) lets the catalog's alternate slugs (e.g. "google" → the Gemini Code
 * Assist credential) resolve to the same instance.
 */

import { BUILTIN_PROVIDERS } from "../../providers/provider-definitions.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { makeCodexCredential } from "./codex-credential.js";
import { GeminiCodeAssistCredentialProvider } from "./gemini-credential.js";
import { makeKimiCredential } from "./kimi-credential.js";
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

  isAuthenticated(name: string): boolean {
    try {
      return this.registry.get(name)?.isAuthenticated() ?? false;
    } catch {
      return false;
    }
  }

  async getRequestAuth(name: string, ctx: RequestAuthContext): Promise<RequestAuth> {
    const p = this.registry.get(name);
    if (!p) throw new Error(`No credential provider for ${name}`);
    return p.getRequestAuth(ctx);
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
    authority.register(makeKimiCredential(), ["kimi", "kimi-coding"]);
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
        }),
        [def.name]
      );
    }

    return authority;
  }
}

export const credentials = CredentialAuthority.buildDefault();
