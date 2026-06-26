/**
 * ApiKeyCredentialProvider — the credential authority for API-key providers.
 *
 * Resolution order (all SYNC):
 *   1. process.env[envVar]
 *   2. process.env[alias] for each alias
 *   3. getApiKey(envVar) — config.json apiKeys map
 *
 * NOTE on 1Password: this provider does NOT resolve `op://` references here.
 * That is an async SDK call and `isAuthenticated()` must stay sync. The up-front
 * op:// resolve (a later refactor step) hydrates process.env at startup, so this
 * sync check sees glob-resolved keys via step (1).
 */

import { getApiKey } from "../../profile-config.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export interface ApiKeyDescriptor {
  catalogName: string;
  envVar: string;
  aliases?: string[];
  authScheme?: "bearer" | "x-api-key";
  staticHeaders?: Record<string, string>;
}

export class ApiKeyCredentialProvider implements CredentialProvider {
  readonly catalogName: string;
  private readonly envVar: string;
  private readonly aliases: string[];
  private readonly authScheme: "bearer" | "x-api-key";
  private readonly staticHeaders: Record<string, string>;

  constructor(descriptor: ApiKeyDescriptor) {
    this.catalogName = descriptor.catalogName;
    this.envVar = descriptor.envVar;
    this.aliases = descriptor.aliases ?? [];
    this.authScheme = descriptor.authScheme ?? "bearer";
    this.staticHeaders = descriptor.staticHeaders ?? {};
  }

  /** SYNC: env → aliases → config.json apiKeys. Never resolves op://. */
  private resolveSync(): string | undefined {
    return (
      process.env[this.envVar] || this.aliases.find((a) => process.env[a]) || getApiKey(this.envVar)
    );
  }

  isAuthenticated(): boolean {
    return !!this.resolveSync();
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
