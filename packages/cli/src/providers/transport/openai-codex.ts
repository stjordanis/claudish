/**
 * OpenAI Codex ProviderTransport
 *
 * Extends OpenAI transport with OAuth token support for ChatGPT Plus/Pro subscriptions.
 *
 * The transport no longer manages OAuth itself. On each request, composed-handler
 * calls refreshAuth() (BEFORE transformPayload/getEndpoint/getHeaders), which
 * delegates to the credential authority's getRequestAuth("openai-codex"). The
 * authority's Codex credential mints the OAuth artifact (chatgpt.com endpoint +
 * OAuth headers + store:false/include payload transform), and applies the
 * OPENAI_CODEX_API_KEY fallback internally. When OAuth is unavailable the authority
 * throws/falls through, cachedAuth stays null, and the transport uses the plain
 * api-key path (api.openai.com + Bearer key) from the OpenAI base transport.
 *
 * IMPORTANT: OAuth tokens only work with chatgpt.com/backend-api, NOT api.openai.com.
 */

import { OpenAIProviderTransport } from "./openai.js";
import { credentials } from "../../auth/credentials/authority.js";
import type { RequestAuth } from "../../auth/credentials/types.js";
import { normalizeCodexModel } from "../../adapters/codex-api-format.js";

export class OpenAICodexTransport extends OpenAIProviderTransport {
  /**
   * The per-request auth artifact, populated by refreshAuth() (called before
   * getEndpoint/getHeaders/transformPayload). Null when OAuth is unavailable —
   * the transport then falls back to the OpenAI base transport's api-key path.
   */
  private cachedAuth: RequestAuth | null = null;

  /**
   * Resolve OAuth (or fall through to api-key) via the credential authority and
   * cache the artifact. composed-handler calls this before getEndpoint/getHeaders.
   * The Codex credential ignores ctx.model, so "" is fine.
   */
  async refreshAuth(): Promise<void> {
    try {
      this.cachedAuth = await credentials.getRequestAuth("openai-codex", { model: "" });
    } catch {
      // No OAuth (or refresh failed) → use the api-key path below.
      this.cachedAuth = null;
    }
  }

  /**
   * OAuth tokens only work with chatgpt.com/backend-api (endpoint comes from the
   * cached auth artifact). API keys use the standard OpenAI endpoint (super).
   */
  override getEndpoint(_targetModel?: string): string {
    return this.cachedAuth?.endpoint ?? super.getEndpoint();
  }

  override async getHeaders(): Promise<Record<string, string>> {
    if (this.cachedAuth) return { ...this.cachedAuth.headers };
    // Fall back to API key auth (Bearer <OPENAI_CODEX_API_KEY>).
    return super.getHeaders();
  }

  /**
   * Normalize the model name for the ChatGPT backend (a pure, non-auth transform —
   * the ChatGPT backend only knows ChatGPT-specific model names like "gpt-5.1").
   * The auth-derived bits (store:false / include reasoning) come from the cached
   * auth artifact's transformPayload, applied only when OAuth is active.
   */
  transformPayload(payload: any): any {
    if (payload?.model) {
      const normalized = normalizeCodexModel(payload.model);
      if (normalized !== payload.model) {
        payload = { ...payload, model: normalized };
      }
    }
    // Auth-derived store:false / include reasoning bits, only under OAuth.
    return this.cachedAuth?.transformPayload?.(payload) ?? payload;
  }
}
