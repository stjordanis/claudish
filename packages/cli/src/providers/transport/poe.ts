/**
 * PoeProvider — Poe API transport.
 *
 * Transport concerns:
 * - Bearer token auth (POE_API_KEY)
 * - Fixed endpoint: https://api.poe.com/v1/chat/completions
 * - Standard OpenAI SSE format
 */

import type { ProviderTransport, StreamFormat } from "./types.js";
import { credentials } from "../../auth/credentials/authority.js";

const POE_API_URL = "https://api.poe.com/v1/chat/completions";

export class PoeProvider implements ProviderTransport {
  readonly name = "poe";
  readonly displayName = "Poe";
  readonly streamFormat: StreamFormat = "openai-sse";

  // The apiKey param is retained for signature compatibility but is no longer the
  // signing source — the Poe key resolves through the credential authority.
  constructor(_apiKey?: string) {}

  getEndpoint(): string {
    return POE_API_URL;
  }

  async getHeaders(): Promise<Record<string, string>> {
    const auth = await credentials.getRequestAuth("poe", { model: "" });
    return auth.headers;
  }
}
