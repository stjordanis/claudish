/**
 * Vertex AI credential — ADC / service-account based (no interactive login).
 *
 * Availability mirrors the existing vertex profile (provider-profiles.ts):
 * either VERTEX_API_KEY (Express mode) is set OR a Vertex project is configured
 * (VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT, via getVertexConfig()). The request
 * token is obtained from the shared VertexAuthManager (gcloud ADC or service
 * account); there is no login/logout because auth is ADC-based.
 */

import { getVertexAuthManager, getVertexConfig } from "../vertex-auth.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export class VertexCredentialProvider implements CredentialProvider {
  readonly catalogName = "vertex";

  isAuthenticated(): boolean {
    return !!process.env.VERTEX_API_KEY || !!getVertexConfig();
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    const token = await getVertexAuthManager().getAccessToken();
    return { headers: { Authorization: `Bearer ${token}` } };
  }
}
