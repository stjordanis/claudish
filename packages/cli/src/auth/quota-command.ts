/**
 * Quota/usage subcommand for OAuth providers.
 *
 * Usage:
 *   claudish quota [provider]   - Show quota usage for a provider
 *   claudish usage [provider]   - Alias for quota
 *
 * Registry-based: each provider registers aliases + handler.
 * Adding a new provider = one entry in QUOTA_ADAPTERS.
 */

import { hasOAuthCredentials } from "./oauth-registry.js";
import {
  getValidAccessToken,
  setupGeminiUser,
  retrieveUserQuota,
  getGeminiTierFullName,
  CODE_ASSIST_FALLBACK_CHAIN,
} from "./gemini-oauth.js";
import {
  getRecommendedModels,
  getModelByIdFromFirebase,
} from "../model-loader.js";

// ANSI
const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const I = "\x1b[3m";
const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const MAG = "\x1b[35m";
const CYN = "\x1b[36m";
const WHT = "\x1b[37m";
const GRY = "\x1b[90m";

// ---------------------------------------------------------------------------
// Quota Adapter Registry
// ---------------------------------------------------------------------------

interface QuotaAdapter {
  name: string;
  aliases: string[];
  isAvailable: () => boolean;
  handler: () => Promise<void>;
}

const QUOTA_ADAPTERS: QuotaAdapter[] = [
  {
    name: "Gemini Code Assist",
    aliases: ["gemini", "google", "go", "gemini-codeassist"],
    isAvailable: () => hasOAuthCredentials("google") || hasOAuthCredentials("gemini-codeassist"),
    handler: geminiQuotaHandler,
  },
  {
    name: "Codex (ChatGPT Plus/Pro)",
    aliases: ["codex", "openai", "gpt", "cx", "chatgpt", "openai-codex"],
    isAvailable: () => hasOAuthCredentials("openai-codex"),
    handler: codexQuotaHandler,
  },
];

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function quotaCommand(provider?: string): Promise<void> {
  if (!provider) {
    const { select } = await import("@inquirer/prompts");
    const choices = QUOTA_ADAPTERS.map((a) => ({
      name: `${a.name} \u2014 ${a.isAvailable() ? "logged in" : "not logged in"}`,
      value: a,
    }));
    const selected = await select({ message: "Select provider:", choices });
    return selected.handler();
  }

  const target = provider.toLowerCase();
  const adapter = QUOTA_ADAPTERS.find((a) => a.aliases.includes(target));

  if (!adapter) {
    const allAliases = QUOTA_ADAPTERS.flatMap((a) => a.aliases);
    console.error(`Unknown provider: ${provider}`);
    console.error(`Available: ${allAliases.join(", ")}`);
    process.exit(1);
  }

  if (!adapter.isAvailable()) {
    console.error(`${RED}Not logged in for ${adapter.name}.${R} Run: ${B}claudish login${R}`);
    process.exit(1);
  }

  return adapter.handler();
}

// ---------------------------------------------------------------------------
// Gemini handler
// ---------------------------------------------------------------------------

async function geminiQuotaHandler(): Promise<void> {
  if (!hasOAuthCredentials("google") && !hasOAuthCredentials("gemini-codeassist")) {
    console.error(`${RED}Not logged in.${R} Run: ${B}claudish login gemini${R}`);
    process.exit(1);
  }

  try {
    const accessToken = await getValidAccessToken();
    const { projectId } = await setupGeminiUser(accessToken);
    const tierName = getGeminiTierFullName();

    const quota = await retrieveUserQuota(accessToken, projectId);
    if (!quota?.buckets?.length) {
      console.log(`\n  ${D}No quota data available.${R}\n`);
      process.exit(0);
    }

    const W = 58;

    // Header box
    console.log("");
    console.log(`  ${CYN}\u256d${"\u2500".repeat(W)}\u256e${R}`);
    console.log(`  ${CYN}\u2502${R} ${B}${WHT}Gemini Code Assist Quota${R}${" ".repeat(W - 25)}${CYN}\u2502${R}`);
    console.log(`  ${CYN}\u251c${"\u2500".repeat(W)}\u2524${R}`);
    console.log(`  ${CYN}\u2502${R} ${GRY}Tier${R}     ${WHT}${tierName}${R}${" ".repeat(Math.max(0, W - 10 - tierName.length))}${CYN}\u2502${R}`);
    console.log(`  ${CYN}\u2502${R} ${GRY}Project${R}  ${WHT}${projectId}${R}${" ".repeat(Math.max(0, W - 10 - projectId.length))}${CYN}\u2502${R}`);
    console.log(`  ${CYN}\u2570${"\u2500".repeat(W)}\u256f${R}`);

    const groups = groupByVersion(quota.buckets);

    // Overall summary
    const allBuckets = quota.buckets.filter((b: QuotaBucket) => typeof b.remainingFraction === "number");
    const avgRemaining = allBuckets.length > 0
      ? allBuckets.reduce((sum: number, b: QuotaBucket) => sum + (b.remainingFraction ?? 0), 0) / allBuckets.length
      : 1;
    const avgUsed = 1 - avgRemaining;
    const summaryColor = avgUsed < 0.5 ? GRN : avgUsed < 0.8 ? YEL : RED;

    console.log("");
    console.log(`  ${summaryColor}${B}${(avgUsed * 100).toFixed(1)}%${R} ${D}overall usage across ${allBuckets.length} models${R}`);
    console.log("");

    // Build a map of modelId -> remaining for fallback chain display
    const remainingByModel = new Map<string, number>();
    for (const b of quota.buckets) {
      if (b.modelId && typeof b.remainingFraction === "number") {
        remainingByModel.set(b.modelId, b.remainingFraction);
      }
    }

    for (const group of groups) {
      console.log(`  ${MAG}${B}${group.title}${R}`);

      for (const bucket of group.buckets) {
        const model = bucket.modelId || "unknown";
        const remaining = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : null;
        const used = remaining !== null ? 1 - remaining : null;
        const reset = bucket.resetTime ? formatRelativeReset(bucket.resetTime) : "";

        const color = used === null ? GRY : used < 0.5 ? GRN : used < 0.8 ? YEL : RED;
        const bar = remaining !== null ? buildUsageBar(used!, color, 24) : `${GRY}${"\u00b7".repeat(24)}${R}`;
        const pct = used !== null ? `${(used * 100).toFixed(1)}%` : "?";

        const nameStr = `  ${GRY}\u2502${R} ${WHT}${model}${R}`;
        const padLen = Math.max(1, 30 - model.length);

        console.log(`${nameStr}${" ".repeat(padLen)}${bar}  ${color}${pct.padStart(6)}${R}  ${GRY}${I}${reset}${R}`);
      }
      console.log("");
    }

    // Fallback chain with live quota status
    console.log(`  ${B}${CYN}Fallback Chain${R} ${D}(on capacity exhaustion)${R}`);
    for (let i = 0; i < CODE_ASSIST_FALLBACK_CHAIN.length; i++) {
      const model = CODE_ASSIST_FALLBACK_CHAIN[i];
      const rem = remainingByModel.get(model);
      const pct = rem !== undefined ? `${((1 - rem) * 100).toFixed(0)}%` : "?";
      const color = rem === undefined ? GRY : rem > 0.5 ? GRN : rem > 0.2 ? YEL : RED;
      const arrow = i < CODE_ASSIST_FALLBACK_CHAIN.length - 1 ? ` ${GRY}\u2192${R}` : "";
      const marker = i === 0 ? `${CYN}\u25b8${R} ` : `  `;
      console.log(`  ${marker}${WHT}${model}${R} ${color}${pct}${R}${arrow}`);
    }
    console.log("");

    // Usage examples — sourced from Firebase recommended catalog so we don't
    // hardcode model IDs that drift as new Gemini releases ship. Filter by
    // provider=google (RecommendedModelEntry lacks `availableInPlans`; that
    // field is on ModelDoc — see §6.E in architecture.md). Dedupe IDs because
    // a single model can appear in multiple categories (vision + subscription).
    const geminiFallback = process.env.CLAUDISH_GEMINI_HELP_FALLBACK ?? "gemini-2.5-flash";
    let geminiExamples: string[];
    try {
      const recs = await getRecommendedModels();
      const seen = new Set<string>();
      geminiExamples = recs.models
        .filter((e) => (e.provider ?? "").toLowerCase() === "google")
        .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
        .slice(0, 2)
        .map((e) => e.id);
      if (geminiExamples.length === 0) {
        geminiExamples = [geminiFallback];
      }
    } catch {
      geminiExamples = [geminiFallback];
    }
    console.log(`  ${B}${CYN}Usage${R}`);
    for (const ex of geminiExamples) {
      console.log(`    ${WHT}claudish --model ${ex}${R}`);
    }
    console.log("");

    // Legend
    console.log(`  ${GRN}\u2588${R}${GRY} <50%${R}   ${YEL}\u2588${R}${GRY} 50-80%${R}   ${RED}\u2588${R}${GRY} >80%${R}   ${D}\u2591 available${R}`);
    console.log("");
  } catch (err: any) {
    console.error(`Failed to fetch quota: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Codex handler
// ---------------------------------------------------------------------------

async function codexQuotaHandler(): Promise<void> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const credPath = join(homedir(), ".claudish", "codex-oauth.json");
  if (!existsSync(credPath)) {
    console.error(`${RED}No Codex credentials found.${R} Run: ${B}claudish login codex${R}`);
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(credPath, "utf-8"));

  // Extract email from JWT access token
  let email = "";
  try {
    const parts = creds.access_token.split(".");
    if (parts.length >= 2) {
      let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4) payload += "=";
      const claims = JSON.parse(Buffer.from(payload, "base64").toString());
      email = claims?.["https://api.openai.com/profile"]?.email || "";
    }
  } catch { /* ignore */ }

  // Resolve the probe model from Firebase so we don't hardcode a Codex model
  // ID that drifts. quotaCommand runs before the launcher catalog warm (R7 in
  // architecture.md §9), so use the async Firebase helper directly. On
  // network failure, fall back to "gpt-5" — preserves today's behavior modulo
  // the alias.
  let probeModel = "gpt-5";
  try {
    const doc = await getModelByIdFromFirebase("gpt-5");
    if (doc?.modelId) probeModel = doc.modelId;
  } catch {
    // Keep the hardcoded fallback above.
  }

  const resp = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      "chatgpt-account-id": creds.account_id || "",
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "codex",
      "OpenAI-Beta": "responses",
    },
    body: JSON.stringify({
      model: probeModel,
      instructions: "Reply with just: ok",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    }),
  });

  const planType = resp.headers.get("x-codex-plan-type") || "unknown";
  const primaryUsed = parseInt(resp.headers.get("x-codex-primary-used-percent") || "", 10);
  const secondaryUsed = parseInt(resp.headers.get("x-codex-secondary-used-percent") || "", 10);
  const primaryResetAt = parseInt(resp.headers.get("x-codex-primary-reset-at") || "0", 10);
  const secondaryResetAt = parseInt(resp.headers.get("x-codex-secondary-reset-at") || "0", 10);
  const hasCredits = resp.headers.get("x-codex-credits-has-credits") === "True";
  const creditsBalance = resp.headers.get("x-codex-credits-balance") || "";

  // Consume body to avoid connection leak
  try { await resp.text(); } catch { /* ignore */ }

  if (isNaN(primaryUsed)) {
    console.error(`${RED}Could not fetch usage data.${R} Headers missing from response.`);
    process.exit(1);
  }

  // Read models from Codex CLI cache
  let modelSlugs: string[] = [];
  try {
    const modelsPath = join(homedir(), ".codex", "models_cache.json");
    if (existsSync(modelsPath)) {
      const cache = JSON.parse(readFileSync(modelsPath, "utf-8"));
      modelSlugs = (cache.models || []).map((m: any) => m.slug || m.id).filter(Boolean);
    }
  } catch { /* ignore */ }

  const W = 58;
  const planLabel = planType.charAt(0).toUpperCase() + planType.slice(1);

  // Header box (Gemini style)
  console.log("");
  console.log(`  ${CYN}\u256d${"\u2500".repeat(W)}\u256e${R}`);
  console.log(`  ${CYN}\u2502${R} ${B}${WHT}Codex Subscription Quota${R}${" ".repeat(W - 25)}${CYN}\u2502${R}`);
  console.log(`  ${CYN}\u251c${"\u2500".repeat(W)}\u2524${R}`);
  const boxRow = (label: string, value: string) => {
    const paddedLabel = label.padEnd(9);
    const visLen = paddedLabel.length + value.length;
    console.log(`  ${CYN}\u2502${R} ${GRY}${paddedLabel}${R}${WHT}${value}${R}${" ".repeat(Math.max(0, W - 1 - visLen))}${CYN}\u2502${R}`);
  };
  boxRow("Plan", planLabel);
  if (email) boxRow("Account", email);
  if (creds.account_id) boxRow("ID", creds.account_id);
  if (hasCredits && creditsBalance) boxRow("Credits", creditsBalance);
  console.log(`  ${CYN}\u2570${"\u2500".repeat(W)}\u256f${R}`);

  // Overall summary
  const overallUsed = Math.max(primaryUsed, secondaryUsed);
  const summaryColor = overallUsed < 50 ? GRN : overallUsed < 80 ? YEL : RED;
  console.log("");
  console.log(`  ${summaryColor}${B}${overallUsed}%${R} ${D}peak usage across rate windows${R}`);
  console.log("");

  // Usage bars
  const primaryColor = primaryUsed < 50 ? GRN : primaryUsed < 80 ? YEL : RED;
  const primaryBar = buildUsageBar(primaryUsed / 100, primaryColor, 24);
  const primaryReset = primaryResetAt > 0 ? formatRelativeReset(new Date(primaryResetAt * 1000).toISOString()) : "";

  const secondaryColor = secondaryUsed < 50 ? GRN : secondaryUsed < 80 ? YEL : RED;
  const secondaryBar = buildUsageBar(secondaryUsed / 100, secondaryColor, 24);
  const secondaryReset = secondaryResetAt > 0 ? formatRelativeReset(new Date(secondaryResetAt * 1000).toISOString()) : "";

  console.log(`  ${GRY}\u2502${R} ${WHT}${"5h window".padEnd(14)}${R}${primaryBar}  ${primaryColor}${String(primaryUsed).padStart(3)}%${R}  ${GRY}${I}${primaryReset}${R}`);
  console.log(`  ${GRY}\u2502${R} ${WHT}${"Weekly".padEnd(14)}${R}${secondaryBar}  ${secondaryColor}${String(secondaryUsed).padStart(3)}%${R}  ${GRY}${I}${secondaryReset}${R}`);
  console.log("");

  // Models
  if (modelSlugs.length > 0) {
    console.log(`  ${B}${CYN}Available Models${R}`);
    for (const slug of modelSlugs) {
      console.log(`    ${WHT}claudish --model cx@${slug}${R}`);
    }
  }
  console.log("");

  // Legend + link
  console.log(`  ${GRN}\u2588${R}${GRY} <50%${R}   ${YEL}\u2588${R}${GRY} 50-80%${R}   ${RED}\u2588${R}${GRY} >80%${R}   ${D}\u2591 available${R}`);
  console.log(`  ${D}https://chatgpt.com/codex/settings/usage${R}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

interface QuotaBucket {
  modelId?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  resetTime?: string;
  tokenType?: string;
}

interface VersionGroup {
  title: string;
  version: string | undefined;
  buckets: QuotaBucket[];
}

function groupByVersion(buckets: QuotaBucket[]): VersionGroup[] {
  const groups = new Map<string, VersionGroup>();
  const sorted = [...buckets].sort((a, b) => (a.modelId || "").localeCompare(b.modelId || ""));

  for (const bucket of sorted) {
    const version = extractVersion(bucket.modelId || "");
    const key = version || "__other__";
    const existing = groups.get(key);
    if (existing) {
      existing.buckets.push(bucket);
    } else {
      groups.set(key, {
        title: version ? `Gemini ${version}` : "Other",
        version,
        buckets: [bucket],
      });
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (!a.version && !b.version) return 0;
    if (!a.version) return 1;
    if (!b.version) return -1;
    return b.version.localeCompare(a.version);
  });
}

function extractVersion(modelId: string): string | undefined {
  const match = modelId.match(/^gemini-([0-9]+(?:\.[0-9]+)*)-/i);
  return match?.[1];
}

function buildUsageBar(usedFraction: number, color: string, width = 24): string {
  const clamped = Math.max(0, Math.min(1, usedFraction));
  const usedCols = clamped >= 1
    ? width
    : Math.max(clamped > 0.005 ? 1 : 0, Math.round(clamped * width));
  const freeCols = width - usedCols;
  const usedPart = usedCols > 0 ? `${color}${"\u2588".repeat(usedCols)}${R}` : "";
  const freePart = freeCols > 0 ? `${D}${"\u2591".repeat(freeCols)}${R}` : "";
  return usedPart + freePart;
}

function formatRelativeReset(resetTime: string): string {
  const resetAt = new Date(resetTime).getTime();
  if (Number.isNaN(resetAt)) return "";
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) return "resets now";
  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `resets ${hours}h ${minutes}m`;
  if (hours > 0) return `resets ${hours}h`;
  return `resets ${minutes}m`;
}
