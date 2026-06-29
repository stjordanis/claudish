/**
 * Default routing rules shipped with claudish.
 *
 * Same shape users edit via `claudish config route` (see `RoutingRules` in
 * `profile-config.ts`). Users can override any pattern (including the catch-all
 * `"*"`) by writing their own routing rules in `~/.claudish/config.json` or a
 * project-local `.claudish.json` — user rules merge ON TOP of these defaults at
 * load time (see `loadRoutingRules` in `routing-rules.ts`).
 *
 * Rule design notes:
 *   - Subscription endpoints come FIRST (people who paid for them want them
 *     used; the chain falls through automatically when subscription credentials
 *     are missing because route() filters by credential availability).
 *   - Direct-API providers come second.
 *   - OpenRouter is last by convention — it's a universal aggregator. Users
 *     who don't want OpenRouter as the catch-all override "*" with their own
 *     chain or [].
 *   - The `provider@model` rewrite syntax (see kimi-* below) is used when a
 *     subscription endpoint expects a different model name than the direct API.
 *
 * Migration plan §B.1 — Commit 4 of the model-catalog and routing redesign.
 */
import type { RoutingRules } from "../profile-config.js";
import { PROVIDER_SHORTCUTS } from "./model-parser.js";
import { getProviderByName } from "./provider-definitions.js";

export const DEFAULT_ROUTING_RULES: RoutingRules = {
  // Anthropic Claude — native first, then OpenRouter.
  "claude-*": ["native-anthropic", "openrouter"],

  // OpenAI families: Codex subscription first, then direct API, then OpenRouter.
  "gpt-*": ["openai-codex", "openai", "openrouter"],
  "o1-*": ["openai-codex", "openai", "openrouter"],
  "o3-*": ["openai-codex", "openai", "openrouter"],

  // Google Gemini: Code Assist subscription, direct API, OpenRouter.
  "gemini-*": ["gemini-codeassist", "google", "openrouter"],

  // xAI Grok: direct API, then OpenRouter (no subscription tier).
  "grok-*": ["x-ai", "openrouter"],

  // Kimi: subscription endpoint accepts only "kimi-for-coding" — provider@model
  // rewrite handles that.
  "kimi-*": ["kimi-coding@kimi-for-coding", "kimi", "openrouter"],

  // MiniMax (matchRoutingRule is case-insensitive, so a single rule covers
  // both `MiniMax-M2.5` and `minimax-m2.5`).
  "minimax-*": ["minimax-coding", "minimax", "openrouter"],

  // GLM: coding plan, direct, OpenRouter.
  "glm-*": ["glm-coding", "glm", "openrouter"],

  // Z.AI native models.
  "z-ai-*": ["z-ai", "openrouter"],

  // DeepSeek: direct API, OpenRouter.
  "deepseek-*": ["deepseek", "openrouter"],

  // Sakana Fugu: subscription first, then token API. NO hardcoded openrouter —
  // we don't claim OpenRouter carries the model; it's reachable explicitly via
  // or@sakana/fugu (catalog-resolved). The bare "fugu" id needs its own exact
  // rule because "fugu-*" only matches hyphenated names.
  fugu: ["sakana-subscription", "sakana"],
  "fugu-*": ["sakana-subscription", "sakana"],

  // OpenCode Zen owns/serves a few model lines exclusively.
  // Pragmatic shim until Firebase aggregators[] coverage closes the gap.
  "*-zen": ["opencode-zen"],

  // Catch-all: try OpenRouter (it covers most things). Users disable with
  // routing["*"] = [] for strict no-fallback mode, or replace with their own
  // chain.
  "*": ["openrouter"],
};

/**
 * Validate that every provider name referenced by a routing rules table exists
 * in `provider-definitions.ts`. Walks each entry, strips the optional
 * `@model` suffix, resolves shortcuts (e.g. `or` → `openrouter`), and looks
 * each canonical provider up.
 *
 * Throws if any rule references a typo provider — dev-time only; the cost is
 * a single sweep at module load and prevents silent no-op rules from shipping
 * to users.
 *
 * Exposed (not just internal) so tests can pass intentionally-broken rule
 * tables to verify the validator's contract.
 */
export function validateRoutingRulesAgainstProviders(rules: RoutingRules): void {
  const unknown: Array<{ rule: string; entry: string; provider: string }> = [];

  for (const ruleKey of Object.keys(rules)) {
    const entries = rules[ruleKey] ?? [];
    for (const entry of entries) {
      const atIdx = entry.indexOf("@");
      const providerRaw = atIdx === -1 ? entry : entry.slice(0, atIdx);
      const canonical = PROVIDER_SHORTCUTS[providerRaw.toLowerCase()] ?? providerRaw.toLowerCase();
      if (!getProviderByName(canonical)) {
        unknown.push({ rule: ruleKey, entry, provider: canonical });
      }
    }
  }

  if (unknown.length > 0) {
    const lines = unknown.map(
      (u) => `  rule "${u.rule}" → entry "${u.entry}" → unknown provider "${u.provider}"`
    );
    throw new Error(
      `[claudish] DEFAULT_ROUTING_RULES references unknown providers:\n${lines.join("\n")}`
    );
  }
}

/**
 * Validate the shipped DEFAULT_ROUTING_RULES at module load. Throws on a typo
 * so the bug surfaces in `bun run build` / test runs instead of as a silent
 * no-route at runtime.
 */
export function validateDefaultRoutingRules(): void {
  validateRoutingRulesAgainstProviders(DEFAULT_ROUTING_RULES);
}

// Eager validation at import time.
validateDefaultRoutingRules();
