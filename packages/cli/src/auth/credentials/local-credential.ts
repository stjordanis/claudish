/**
 * LocalCredentialProvider — readiness oracle for a built-in local provider
 * (ollama, lmstudio, vllm, mlx).
 *
 * "Authenticated" means the user has explicitly enabled the provider in
 * ~/.claudish/config.json (isLocalProviderEnabled). Local providers carry no
 * outgoing auth headers, so getRequestAuth returns an empty header set.
 */

import { isLocalProviderEnabled } from "../../profile-config.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export class LocalCredentialProvider implements CredentialProvider {
  readonly catalogName: string;

  constructor(catalogName: string) {
    this.catalogName = catalogName;
  }

  isAuthenticated(): boolean {
    return isLocalProviderEnabled(this.catalogName);
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    return { headers: {} };
  }
}
