// E2E probe (manual, not part of `bun test`): does the credential authority
// resolve op-backed providers ON DEMAND — the same path the interactive model
// selector and routing use — so a provider whose key lives only in a 1Password
// config glob shows up as available WITHOUT any pre-hydration step?
//
// Run:  bun packages/cli/src/scratch-op-hydrate-check.ts
//
// This exercises the REAL credential authority against the user's REAL
// ~/.claudish/config.json (it will load the 1Password SDK if an op source exists
// and a provider's key is missing from env). It prints which providers the
// authority reports available, and whether op:// keys landed in process.env via
// the write-through mirror.
import { credentials } from "./auth/credentials/authority.js";
import { hasOpSources } from "./auth/credentials/op-source.js";
import { getAllProviders } from "./providers/provider-definitions.js";

const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "MINIMAX_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
  "XAI_API_KEY",
];

(async () => {
  console.log("=== op sources present? ===");
  console.log(hasOpSources() ? "yes (config/flag op:// source detected)" : "no");

  // Snapshot which provider keys are present BEFORE resolution.
  const before = new Set(PROVIDER_KEYS.filter((k) => process.env[k]));

  console.log("\n=== resolving provider availability ON DEMAND (authority.isAvailable) ===");
  const providers = getAllProviders().filter((p) => !p.isLocal && p.apiKeyEnvVar);
  const results = await Promise.all(
    providers.map(async (p) => ({
      name: p.name,
      available: await credentials.isAvailable(p.name),
    }))
  );
  const available = results.filter((r) => r.available).map((r) => r.name);
  console.log(`available providers (${available.length}): ${available.join(", ") || "(none)"}`);

  console.log("\n=== provider keys NEWLY written to env by the authority (op:// write-through) ===");
  const after = PROVIDER_KEYS.filter((k) => process.env[k]);
  const newlyResolved = after.filter((k) => !before.has(k));
  if (newlyResolved.length > 0) {
    for (const k of newlyResolved) {
      const v = process.env[k]!;
      console.log(`  ${k}  ••••${v.length >= 4 ? v.slice(-4) : "????"}`);
    }
  } else {
    console.log("  (none newly resolved — all keys were already in env, or no op source)");
  }

  console.log("\n=== VERDICT ===");
  if (hasOpSources() && available.length > 0) {
    console.log(
      "✓ Authority resolves provider availability on demand (op:// included) — no pre-hydration needed."
    );
  } else if (!hasOpSources()) {
    console.log("• No op source configured — availability reflects env/config/oauth only (expected).");
  } else {
    console.log("? No providers available — check config / credentials.");
  }
  process.exit(0);
})();
