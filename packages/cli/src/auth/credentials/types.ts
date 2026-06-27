/**
 * Credential Authority — core interfaces.
 *
 * A {@link CredentialProvider} is the single authority for one catalog provider's
 * credentials. It answers two distinct questions:
 *
 *  - `isAuthenticated()` — SYNC, cheap, never-throwing readiness oracle (env var
 *    set? config key present? oauth file on disk? local provider enabled?). This
 *    MUST NOT perform a 1Password SDK call or an OAuth token refresh — those are
 *    async and far too expensive for a routing decision.
 *  - `getRequestAuth()` — ASYNC, produces the rich artifact (headers, optional
 *    endpoint override, optional payload transform) for an outgoing request.
 *    OAuth token refreshes happen here, internally.
 */

export interface RequestAuthContext {
  model: string;
  forceRefresh?: boolean;
}

export interface RequestAuth {
  headers: Record<string, string>;
  endpoint?: string;
  transformPayload?(payload: any): any;
}

export interface CredentialProvider {
  readonly catalogName: string;
  /**
   * SYNC, cheap, never throws: env var set? config key? oauth file exists?
   * local enabled? MUST NOT do the 1Password SDK call or an OAuth token refresh.
   */
  isAuthenticated(): boolean;
  /** ASYNC: the rich artifact for an outgoing request. Refreshes OAuth tokens internally. */
  getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth>;
  /**
   * SYNC: the resolved API-key STRING, for the synchronous handler-construction
   * path (proxy-server builds transports before any request, no await). Resolves
   * env → aliases → config (op:// already hydrated into env up front). Returns ""
   * for OAuth/local providers — they never use a construction-time key string;
   * they mint per-request auth via getRequestAuth(). Optional: providers that
   * don't implement it have no construction-time key.
   */
  apiKeyValue?(): string;
  login?(): Promise<void>;
  logout?(): Promise<void>;
}
