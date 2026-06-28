/**
 * Gemini Code Assist credential (OAuth-based, subscription endpoint).
 *
 * The request artifact mirrors providers/transport/gemini-codeassist.ts exactly:
 *  - Authorization: Bearer <oauth token>
 *  - User-Agent: GeminiCLI/<ver>/<model> (<platform>; <arch>)
 *  - x-activity-request-id: short random id (matches gemini-cli activity logger)
 *  - payload wrapped in the CodeAssist envelope
 *    {model, project, user_prompt_id, request: <inner>} (+ enabled_credit_types
 *    for paid tiers).
 */

import { randomUUID } from "node:crypto";
import { GeminiOAuth, getValidAccessToken, setupGeminiUser } from "../gemini-oauth.js";
import { hasOAuthCredentials } from "../oauth-registry.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

/**
 * Build the GeminiCLI User-Agent header (matches gemini-cli format / the
 * transport's buildGeminiCliUserAgent). Without it the backend applies stricter
 * rate limits.
 */
function buildGeminiCliUserAgent(model?: string): string {
  const version = "0.5.6"; // gemini-cli version we're compatible with
  const modelSegment = model || "gemini-code-assist";
  return `GeminiCLI/${version}/${modelSegment} (${process.platform}; ${process.arch})`;
}

/** Generate a short random request ID (matches gemini-cli activity logger). */
function createActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

export class GeminiCodeAssistCredentialProvider implements CredentialProvider {
  readonly catalogName = "gemini-codeassist";

  async isAvailable(): Promise<boolean> {
    return hasOAuthCredentials("gemini-codeassist");
  }

  async getRequestAuth(ctx: RequestAuthContext): Promise<RequestAuth> {
    const token = await getValidAccessToken();
    const { projectId, tierId } = await setupGeminiUser(token);
    return {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": buildGeminiCliUserAgent(ctx.model),
        "x-activity-request-id": createActivityRequestId(),
      },
      transformPayload: (inner: any) => {
        const env: any = {
          model: ctx.model,
          project: projectId,
          user_prompt_id: randomUUID(),
          request: inner,
        };
        if (tierId && tierId !== "free-tier") {
          env.enabled_credit_types = ["GOOGLE_ONE_AI"];
        }
        return env;
      },
    };
  }

  async login(): Promise<void> {
    await GeminiOAuth.getInstance().login();
  }

  async logout(): Promise<void> {
    await GeminiOAuth.getInstance().logout();
  }
}
