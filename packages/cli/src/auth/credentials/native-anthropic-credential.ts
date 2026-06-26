/**
 * NativeAnthropicCredentialProvider — readiness oracle for native Claude Code
 * pass-through.
 *
 * The native Anthropic path handles its own auth downstream; this provider is
 * only the readiness oracle (is an Anthropic key/token present?) and contributes
 * no headers of its own.
 */

import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

export class NativeAnthropicCredentialProvider implements CredentialProvider {
  readonly catalogName = "native-anthropic";

  isAuthenticated(): boolean {
    return !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN;
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    return { headers: {} };
  }
}
