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

  async isAvailable(): Promise<boolean> {
    return !!process.env.VERTEX_API_KEY || !!getVertexConfig();
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    // Express mode: VERTEX_API_KEY is a plain bearer key (standard Gemini
    // endpoint). It is the authority-sourced credential for Express, so the
    // proxy no longer reads process.env.VERTEX_API_KEY directly at sign-time.
    const expressKey = process.env.VERTEX_API_KEY;
    if (expressKey) {
      return { headers: { Authorization: `Bearer ${expressKey}` } };
    }
    // ADC / service-account mode: mint an OAuth access token.
    const token = await getVertexAuthManager().getAccessToken();
    return { headers: { Authorization: `Bearer ${token}` } };
  }
}
