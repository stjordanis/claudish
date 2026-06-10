/**
 * `claudish providers --json` — non-interactive credential-presence report.
 *
 * The claude-desktop-profiles app uses this to annotate the model catalog with
 * "configured on this machine" vs. not. It needs to know WHICH providers have
 * working credentials here and WHERE those credentials come from — but never
 * the credentials themselves.
 *
 * Output (one entry per non-virtual provider):
 *   { "providers": [
 *       { "slug": "x-ai",   "ready": true,  "authSource": "env" },
 *       { "slug": "google", "ready": false, "authSource": null }
 *   ] }
 *
 * The `slug` is the canonical BUILTIN_PROVIDERS name (catalogName) — the same
 * string `claudish serve` accepts as a pinned `provider` in its models.json,
 * and the string parseModelSpec/resolveRemoteProvider match on. (NOT the
 * TUI-facing alias: e.g. slug is "google", not the picker label "gemini".)
 *
 * SECURITY: this command emits credential PRESENCE and SOURCE only. It must
 * never touch the --probe provenance path (which prints unmasked keys) and
 * must never include any value, masked fragment, or key material whatsoever.
 */

import { loadConfig } from "./profile-config.js";
import { PROVIDERS, providerAuthSource, type AuthSource } from "./tui/providers.js";

interface ProviderStatus {
  slug: string;
  ready: boolean;
  authSource: AuthSource;
}

/**
 * Build the provider-status list. Pure function over PROVIDERS + config so it
 * stays trivially testable and side-effect free (apart from reading config,
 * which providerAuthSource needs).
 */
export function collectProviderStatuses(
  config: { apiKeys?: Record<string, string>; localProviders?: string[] } = loadConfig()
): ProviderStatus[] {
  return PROVIDERS.map((p) => {
    const authSource = providerAuthSource(p, config);
    return {
      // Canonical provider name — the slug the profiles app round-trips back
      // as `provider` in serve's models.json.
      slug: p.catalogName,
      ready: authSource !== null,
      authSource,
    };
  });
}

export async function providersCommand(opts: { json: boolean }): Promise<void> {
  const providers = collectProviderStatuses();

  if (opts.json) {
    // Stable, machine-readable output. No key material anywhere — only the
    // presence boolean and the source enum.
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }

  // Human-readable fallback (no --json). Still presence + source only.
  for (const p of providers) {
    const mark = p.ready ? "✓" : "·";
    const src = p.authSource ?? "—";
    console.log(`${mark} ${p.slug.padEnd(20)} ${src}`);
  }
}
