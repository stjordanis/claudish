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
  login?(): Promise<void>;
  logout?(): Promise<void>;
}
