/**
 * ApiKeyCredentialProvider — the credential authority for API-key providers.
 *
 * Resolution order for the request KEY (all SYNC):
 *   1. process.env[envVar]
 *   2. process.env[alias] for each alias
 *   3. getApiKey(envVar) — config.json apiKeys map
 *
 * `isAuthenticated()` additionally honors two affordances that the legacy
 * `isProviderAvailable()` oracle granted (and which `hasCredentialsForProvider`
 * relied on), so the authority is behavior-equivalent to the old readiness gate:
 *   - `publicKeyFallback`: the provider has a free/public key, so it is ALWAYS
 *     authenticated (e.g. OpenCode Zen's "public" tier).
 *   - `oauthFallback`: a `<file>` under ~/.claudish/ — if that OAuth credential
 *     file exists, the provider is authenticated even without an env/config key
 *     (mirrors `isProviderAvailable`'s existsSync branch). This is the SAME
 *     cheap existsSync the old oracle did — no token parse, still sync.
 *
 * NOTE on 1Password: this provider does NOT resolve `op://` references here.
 * That is an async SDK call and `isAuthenticated()` must stay sync. The up-front
 * op:// resolve hydrates process.env at startup, so this sync check sees
 * glob-resolved keys via step (1).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getApiKey } from "../../profile-config.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export interface ApiKeyDescriptor {
  catalogName: string;
  envVar: string;
  aliases?: string[];
  authScheme?: "bearer" | "x-api-key";
  staticHeaders?: Record<string, string>;
  /**
   * Provider has a public/free key → always authenticated regardless of env or
   * config. Mirrors ProviderDefinition.publicKeyFallback.
   */
  publicKeyFallback?: boolean;
  /**
   * OAuth credential filename under ~/.claudish/ (e.g. "codex-oauth.json"). If
   * the file exists, the provider counts as authenticated even with no API key.
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

  constructor(descriptor: ApiKeyDescriptor) {
    this.catalogName = descriptor.catalogName;
    this.envVar = descriptor.envVar;
    this.aliases = descriptor.aliases ?? [];
    this.authScheme = descriptor.authScheme ?? "bearer";
    this.staticHeaders = descriptor.staticHeaders ?? {};
    this.publicKeyFallback = descriptor.publicKeyFallback ?? false;
    this.oauthFallback = descriptor.oauthFallback;
  }

  /** SYNC: env → aliases → config.json apiKeys. Never resolves op://. */
  private resolveSync(): string | undefined {
    return (
      process.env[this.envVar] || this.aliases.find((a) => process.env[a]) || getApiKey(this.envVar)
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

  isAuthenticated(): boolean {
    if (this.publicKeyFallback) return true;
    return !!this.resolveSync() || this.hasOauthFallbackFile();
  }

  /** SYNC resolved key string for the construction path (env → aliases → config). */
  apiKeyValue(): string {
    return this.resolveSync() ?? "";
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    const key = this.resolveSync() || "";
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
