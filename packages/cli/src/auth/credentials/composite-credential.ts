/**
 * CompositeCredentialProvider — tries a primary credential source, falls back
 * to a secondary one.
 *
 * Used for OAuth-or-API-key providers (Codex, Kimi): the OAuth half is primary,
 * the API-key half is the fallback. A `fallbackSignal` lets the primary opt into
 * a fallback by throwing a sentinel error message (e.g. Kimi throws
 * "OAuth_FALLBACK_TO_API_KEY" when its refresh fails and an API key is present).
 */

import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export interface CompositeOptions {
  /**
   * If set, a primary `getRequestAuth()` that throws an error whose message
   * exactly equals this string falls through to the fallback. Any other error
   * is rethrown.
   */
  fallbackSignal?: string;
}

export class CompositeCredentialProvider implements CredentialProvider {
  readonly catalogName: string;
  private readonly primary: CredentialProvider;
  private readonly fallback: CredentialProvider;
  private readonly opts: CompositeOptions;

  constructor(
    catalogName: string,
    primary: CredentialProvider,
    fallback: CredentialProvider,
    opts: CompositeOptions = {}
  ) {
    this.catalogName = catalogName;
    this.primary = primary;
    this.fallback = fallback;
    this.opts = opts;
  }

  isAuthenticated(): boolean {
    return this.primary.isAuthenticated() || this.fallback.isAuthenticated();
  }

  /** Construction-time key string comes from the API-key fallback half. */
  apiKeyValue(): string {
    return this.fallback.apiKeyValue?.() ?? "";
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    if (this.primary.isAuthenticated()) {
      try {
        return await this.primary.getRequestAuth(ctx);
      } catch (e: any) {
        const signal = this.opts.fallbackSignal;
        if (signal && String(e?.message) === signal) {
          return this.fallback.getRequestAuth(ctx);
        }
        throw e;
      }
    }
    return this.fallback.getRequestAuth(ctx);
  }

  async login(): Promise<void> {
    await this.primary.login?.();
  }

  async logout(): Promise<void> {
    await this.primary.logout?.();
  }
}
