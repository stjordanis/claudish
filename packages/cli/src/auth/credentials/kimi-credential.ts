/**
 * Kimi / Moonshot credential — OAuth with API-key fallback.
 *
 * `makeKimiCredential()` returns a CompositeCredentialProvider: the OAuth half
 * ({@link KimiOAuthHalf}) is primary, an API-key provider keyed on
 * MOONSHOT_API_KEY (with KIMI_API_KEY / KIMI_CODING_API_KEY aliases) is the
 * fallback. The OAuth refresh throws "OAuth_FALLBACK_TO_API_KEY" when it fails
 * and an API key is present — the composite's `fallbackSignal` catches exactly
 * that and falls through.
 */

import { KimiOAuth } from "../kimi-oauth.js";
import { hasOAuthCredentials } from "../oauth-registry.js";
import { ApiKeyCredentialProvider } from "./api-key-credential.js";
import { CompositeCredentialProvider } from "./composite-credential.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

/**
 * The OAuth half of the Kimi composite credential.
 */
export class KimiOAuthHalf implements CredentialProvider {
  readonly catalogName = "kimi";
  private oauth = KimiOAuth.getInstance();

  isAuthenticated(): boolean {
    return hasOAuthCredentials("kimi");
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    // May throw "OAuth_FALLBACK_TO_API_KEY" — the composite catches it.
    const token = await this.oauth.getAccessToken();
    return {
      headers: {
        "anthropic-version": "2023-06-01",
        Authorization: `Bearer ${token}`,
        ...this.oauth.getPlatformHeaders(),
      },
    };
  }

  async login(): Promise<void> {
    await this.oauth.login();
  }

  async logout(): Promise<void> {
    await this.oauth.logout();
  }
}

/**
 * Build the full Kimi credential: OAuth primary + MOONSHOT_API_KEY fallback.
 */
export function makeKimiCredential(): CompositeCredentialProvider {
  return new CompositeCredentialProvider(
    "kimi",
    new KimiOAuthHalf(),
    new ApiKeyCredentialProvider({
      catalogName: "kimi",
      envVar: "MOONSHOT_API_KEY",
      aliases: ["KIMI_API_KEY", "KIMI_CODING_API_KEY"],
    }),
    { fallbackSignal: "OAuth_FALLBACK_TO_API_KEY" }
  );
}
