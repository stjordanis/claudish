/**
 * ApiKeyCredentialProvider — the credential authority for API-key providers.
 *
 * Resolution order (ASYNC, memoized per provider):
 *   1. process.env[envVar]
 *   2. process.env[alias] for each alias
 *   3. getApiKey(envVar) — config.json apiKeys map
 *   4. 1Password (op:// — lazy SDK, only when 1-3 missed AND an op source exists)
 *
 * When step 4 resolves a key, the value is written THROUGH into process.env so
 * spawned child processes (MCP team/channel) inherit it and never touch the SDK.
 * The authority is the ONLY code that pushes op:// keys into process.env.
 *
 * `isAvailable()` additionally honors two affordances the legacy oracle granted:
 *   - `publicKeyFallback`: the provider has a free/public key → always available.
 *   - `oauthFallback`: a `<file>` under ~/.claudish/ — if that OAuth credential
 *     file exists, the provider is available even without an env/config/op key.
 *
 * Resolution is memoized: the first await pays the env/config/op cost; later
 * reads return the cached result. `invalidate()` clears it (TUI hydrate-on-add).
 * An empty/failed op resolve is NOT cached as "" — it's cached as "unavailable"
 * only after the op source is consulted, and `invalidate()` re-opens it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getApiKey } from "../../profile-config.js";
import { hasOpSources, resolveOpKeyForEnvVars } from "./op-source.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export interface ApiKeyDescriptor {
  catalogName: string;
  envVar: string;
  aliases?: string[];
  authScheme?: "bearer" | "x-api-key";
  staticHeaders?: Record<string, string>;
  /**
   * Provider has a public/free key → always available regardless of env or
   * config. Mirrors ProviderDefinition.publicKeyFallback.
   */
  publicKeyFallback?: boolean;
  /**
   * OAuth credential filename under ~/.claudish/ (e.g. "codex-oauth.json"). If
   * the file exists, the provider counts as available even with no API key.
   * Mirrors ProviderDefinition.oauthFallback.
   */
  oauthFallback?: string;
}

export class ApiKeyCredentialProvider implements CredentialProvider {
  readonly catalogName: string;
  private readonly envVar: string;
  private readonly aliases: string[];
  private readonly authScheme: "bearer" | "x-api-key";
  private readonly staticHeaders: Record<string, string>;
  private readonly publicKeyFallback: boolean;
  private readonly oauthFallback?: string;

  /** Memoized resolved key ("" = resolved-and-empty). undefined = not yet resolved. */
  private cachedKey: string | undefined;
  /** In-flight resolution, so concurrent callers share one op pull. */
  private resolving: Promise<string> | undefined;

  constructor(descriptor: ApiKeyDescriptor) {
    this.catalogName = descriptor.catalogName;
    this.envVar = descriptor.envVar;
    this.aliases = descriptor.aliases ?? [];
    this.authScheme = descriptor.authScheme ?? "bearer";
    this.staticHeaders = descriptor.staticHeaders ?? {};
    this.publicKeyFallback = descriptor.publicKeyFallback ?? false;
    this.oauthFallback = descriptor.oauthFallback;
  }

  /** SYNC: env → aliases → config.json apiKeys. Does NOT touch 1Password. */
  private resolveFromEnvConfig(): string | undefined {
    // NOTE: map alias names to their VALUES before .find — `aliases.find(a =>
    // process.env[a])` would return the alias NAME (a truthy string), so the
    // credential would send the literal env-var name as the API key → 401.
    return (
      process.env[this.envVar] ||
      this.aliases.map((a) => process.env[a]).find((v) => !!v) ||
      getApiKey(this.envVar)
    );
  }

  /** SYNC: does the oauthFallback credential file exist under ~/.claudish/? */
  private hasOauthFallbackFile(): boolean {
    if (!this.oauthFallback) return false;
    try {
      return existsSync(join(homedir(), ".claudish", this.oauthFallback));
    } catch {
      return false;
    }
  }

  /**
   * ASYNC resolved key: env → aliases → config → op:// (lazy). Memoized; the
   * op pull happens at most once. Writes a resolved op key THROUGH to
   * process.env so spawned children inherit it.
   */
  private async resolveKey(opts?: { allowOpPrompt?: boolean }): Promise<string> {
    if (this.cachedKey !== undefined) return this.cachedKey;
    if (this.resolving) return this.resolving;

    this.resolving = (async () => {
      // Steps 1-3: env / aliases / config — no SDK.
      const local = this.resolveFromEnvConfig();
      if (local) {
        this.cachedKey = local;
        return local;
      }
      // Step 4: 1Password, only if a source exists (the sync sniff gates the SDK).
      if (hasOpSources()) {
        const wanted = new Set<string>([this.envVar, ...this.aliases]);
        const resolved = await resolveOpKeyForEnvVars(wanted, {
          onAuthFailure: "skip",
          allowPrompt: opts?.allowOpPrompt ?? false,
        });
        const value =
          resolved[this.envVar] ?? this.aliases.map((a) => resolved[a]).find((v) => !!v);
        if (value) {
          // Write-through mirror: child processes inherit this, no re-resolve.
          process.env[this.envVar] = value;
          this.cachedKey = value;
          return value;
        }
        // op source EXISTS but resolution came back empty — this can be a
        // TRANSIENT op-auth failure (onAuthFailure:"skip" swallows it). Do NOT
        // cache the miss, or a single early failure would mark the provider
        // permanently unavailable. Return "" WITHOUT caching so the next call
        // retries (e.g. once the 1Password desktop handshake completes).
        return "";
      }
      // No op source at all → the empty result is stable; safe to cache.
      this.cachedKey = "";
      return "";
    })();

    try {
      return await this.resolving;
    } finally {
      this.resolving = undefined;
    }
  }

  async isAvailable(opts?: { allowOpPrompt?: boolean }): Promise<boolean> {
    if (this.publicKeyFallback) return true;
    // Cheap checks first — avoid the op pull when an oauth file already qualifies.
    if (this.resolveFromEnvConfig()) return true;
    if (this.hasOauthFallbackFile()) return true;
    const key = await this.resolveKey(opts);
    return !!key;
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.resolving = undefined;
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    const key = await this.resolveKey({ allowOpPrompt: ctx.allowOpPrompt });
    let headers: Record<string, string>;
    if (this.authScheme === "x-api-key") {
      headers = { "x-api-key": key, ...this.staticHeaders };
    } else if (key) {
      headers = { Authorization: `Bearer ${key}`, ...this.staticHeaders };
    } else {
      headers = { ...this.staticHeaders };
    }
    return { headers };
  }
}
