/**
 * Anthropic-Compatible ProviderTransport
 *
 * Handles communication with providers that speak native Anthropic API format
 * (MiniMax, Kimi, Kimi Coding, Z.AI). Auth uses x-api-key header with
 * anthropic-version, plus Kimi OAuth fallback for kimi-coding.
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import type { RemoteProvider } from "../../handlers/shared/remote-provider-types.js";
import { log } from "../../logger.js";
import { credentials } from "../../auth/credentials/authority.js";
import { isTerminal429 } from "./openai.js";

export class AnthropicProviderTransport implements ProviderTransport {
  readonly name: string;
  readonly displayName: string;
  readonly streamFormat: StreamFormat = "anthropic-sse";

  private provider: RemoteProvider;
  private apiKey: string;

  constructor(provider: RemoteProvider, apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.name = provider.name;
    this.displayName = AnthropicProviderTransport.formatDisplayName(provider.name);
  }

  getEndpoint(): string {
    return `${this.provider.baseUrl}${this.provider.apiPath}`;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };

    if (this.provider.authScheme === "bearer") {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    } else {
      headers["x-api-key"] = this.apiKey;
    }

    // Add provider-specific headers
    if (this.provider.headers) {
      Object.assign(headers, this.provider.headers);
    }

    // Kimi Coding: OAuth wins over API key when both are present.
    // Per kimi.com/code docs, the canonical auth path for the coding
    // subscription is OAuth (claudish login kimi). A stale or wrong
    // KIMI_CODING_API_KEY env var would otherwise produce 401 even
    // though the user has a valid OAuth token on disk.
    //
    // The transport no longer manages OAuth itself — it delegates to the
    // credential authority, which mints the OAuth artifact (anthropic-version +
    // Bearer token + the X-Msh-* platform headers) and applies the
    // OAuth_FALLBACK_TO_API_KEY → api-key fallback internally. On failure here
    // we keep the plain x-api-key path already populated above.
    if (this.provider.name === "kimi-coding") {
      try {
        const auth = await credentials.getRequestAuth("kimi-coding", { model: "" });
        // If the authority returned an OAuth Bearer, it replaces the api-key auth.
        if (auth.headers.Authorization) {
          delete headers["x-api-key"];
        }
        Object.assign(headers, auth.headers);
      } catch (e: any) {
        log(`[${this.displayName}] OAuth path failed, falling back to API key: ${e.message}`);
      }
    }

    return headers;
  }

  /**
   * Retry 429 responses with bounded backoff. Anthropic-compat providers
   * (Kimi, MiniMax, Z.AI) throttle aggressively; one quick retry helps
   * recover transient bursts. The retry budget is intentionally tight
   * (~3s worst case) so probe deadlines (typically 15s) don't get blown
   * by an extended retry chain — the probe surfaces 429 as a healthy
   * "throttled" signal instead.
   *
   * Terminal 429s (billing/quota) skip the retry chain — see isTerminal429
   * in transport/openai.ts for the patterns matched.
   */
  async enqueueRequest(fetchFn: () => Promise<Response>): Promise<Response> {
    const maxRetries = 2;
    let lastResponse: Response | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetchFn();

      if (response.status === 429 && attempt < maxRetries) {
        const bodyText = await response
          .clone()
          .text()
          .catch(() => "");
        if (isTerminal429(bodyText)) {
          log(`[${this.displayName}] 429 is terminal (billing/quota), not retrying`);
          return response;
        }
        lastResponse = response;
        const retryAfter = response.headers.get("Retry-After");
        let delayMs: number;
        if (retryAfter && !Number.isNaN(Number(retryAfter))) {
          delayMs = Math.min(Number(retryAfter) * 1000, 2000);
        } else {
          // 500ms, 1000ms — quick recovery without blowing probe budget
          delayMs = 500 * (attempt + 1);
        }
        log(
          `[${this.displayName}] 429 rate limited, retry ${attempt + 1}/${maxRetries} in ${(delayMs / 1000).toFixed(1)}s`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      return response;
    }

    return lastResponse!;
  }

  private static formatDisplayName(name: string): string {
    const map: Record<string, string> = {
      minimax: "MiniMax",
      "minimax-coding": "MiniMax Coding",
      kimi: "Kimi",
      "kimi-coding": "Kimi Coding",
      moonshot: "Kimi",
      "z-ai": "Z.AI",
    };
    return map[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
  }
}

// Backward-compatible alias
/** @deprecated Use AnthropicProviderTransport */
export { AnthropicProviderTransport as AnthropicCompatProvider };
