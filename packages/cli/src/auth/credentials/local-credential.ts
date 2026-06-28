/**
 * LocalCredentialProvider — credential authority for a built-in local provider
 * (ollama, lmstudio, vllm, mlx).
 *
 * Availability means the user enabled the provider in ~/.claudish/config.json
 * (isLocalProviderEnabled). Local providers usually carry NO outgoing auth, but
 * some local gateways require a bearer token (<NAME>_API_KEY) — when present it
 * is resolved through the authority (env → config → op://) and returned as a
 * Bearer header, so even the local-token path goes through the single layer.
 */

import { getApiKey, isLocalProviderEnabled } from "../../profile-config.js";
import { hasOpSources, resolveOpKeyForEnvVars } from "./op-source.js";
import type { CredentialProvider, RequestAuth, RequestAuthContext } from "./types.js";

/** Map a local provider's catalog name to its bearer-token env var. */
const LOCAL_KEY_ENV: Record<string, string> = {
  ollama: "OLLAMA_API_KEY",
  lmstudio: "LMSTUDIO_API_KEY",
  vllm: "VLLM_API_KEY",
  mlx: "MLX_API_KEY",
};

export class LocalCredentialProvider implements CredentialProvider {
  readonly catalogName: string;
  private cachedKey: string | undefined;

  constructor(catalogName: string) {
    this.catalogName = catalogName;
  }

  async isAvailable(): Promise<boolean> {
    return isLocalProviderEnabled(this.catalogName);
  }

  invalidate(): void {
    this.cachedKey = undefined;
  }

  /** Resolve this provider's optional bearer token: env → config → op://. */
  private async resolveKey(): Promise<string> {
    if (this.cachedKey !== undefined) return this.cachedKey;
    const envVar = LOCAL_KEY_ENV[this.catalogName];
    if (!envVar) return (this.cachedKey = "");
    const local = process.env[envVar] || getApiKey(envVar);
    if (local) return (this.cachedKey = local);
    if (hasOpSources()) {
      const resolved = await resolveOpKeyForEnvVars(new Set([envVar]), { onAuthFailure: "skip" });
      const v = resolved[envVar];
      if (v) {
        process.env[envVar] = v; // write-through mirror
        return (this.cachedKey = v);
      }
    }
    return (this.cachedKey = "");
  }

  async getRequestAuth(_ctx: RequestAuthContext): Promise<RequestAuth> {
    const key = await this.resolveKey();
    return key ? { headers: { Authorization: `Bearer ${key}` } } : { headers: {} };
  }
}
