/**
 * op-source — the lazy 1Password seam BEHIND the credential authority.
 *
 * This is the single place that knows how to pull a provider's API key out of
 * 1Password ON DEMAND. The authority calls `resolveOpKeyForEnvVars(wanted)` only
 * when env/config/oauth-file have all missed for a provider — so a non-op user,
 * or an op user whose key is already in the shell env, never reaches the SDK.
 *
 * LAZINESS GATE: `hasOpSources()` is a cheap SYNC sniff (one readFileSync of
 * config.json + an argv scan for --op/--op-env). It returns false — WITHOUT
 * importing `@1password/sdk` or its ~10MB WASM — when there is no 1Password
 * source at all. The authority calls it before ever attempting an op resolve.
 *
 * SERIALIZATION: every SDK touch goes through the resolver functions in
 * onepassword.ts, which already wrap calls in `runSdkExclusive` (the -4 IPC
 * fix). This module adds no new concurrency.
 *
 * GLOB SINGLE-FLIGHT: a configured glob (op://Vault/Item/**) is resolved ONCE
 * per process — the first resolve discovers the item and batch-resolves ALL
 * matching env vars into `resolvedCache`; every other provider's resolve is a
 * cache pick, not a re-discovery (see resolveGlobShared). Without this, the
 * 26-provider config-TUI startup re-ran the full discovery per provider,
 * serialized — ~34s of redundant SDK work on a 36s launch.
 *
 * AUTH POLICY: a multi-account / no-auth failure is surfaced as a thrown
 * `OpAuthError`. The caller chooses what to do via `onAuthFailure`:
 *   - "throw"  (default for explicit --op/--op-env flags) → propagate, hard-fail.
 *   - "skip"   (config-driven routing) → the authority catches it and the
 *     provider resolves as "not available", so the MCP/serve server keeps
 *     running instead of dying at startup.
 *
 * This module replaces the per-entry-point PUSH-into-process.env machinery that
 * used to live in index.ts (loadStoredApiKeys / applyCustomEndpointOpKeys /
 * getSdkAuth). There is no "resolve everything" pass here — resolution is
 * strictly scoped to the env-var names a caller asks for.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readAllOnepasswordEnvironments,
  readOnepasswordAccount,
  saveOnepasswordAccount as saveOpConfigAccount,
} from "../../providers/onepassword-config.js";
import type { AccountInfo, SdkAuth, SdkClientFactory } from "../../providers/onepassword.js";
import { type SpanMeta, addSpanMeta, beginQueuedSpan, traceSpan } from "../../startup-trace.js";

/** Thrown when no usable 1Password SDK auth can be resolved. */
export class OpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpAuthError";
  }
}

/** What to do when SDK auth resolution fails. */
export type OnAuthFailure = "throw" | "skip";

// ── Lazy SDK-auth resolution (memoized once per process) ────────────────────

let cachedSdkAuth: SdkAuth | undefined;
let sdkAuthResolved = false;
let authInFlight: Promise<SdkAuth | undefined> | undefined;

/**
 * Persist a picked account URL as `onepasswordAccount`. Best-effort: a save
 * failure only means the user is re-prompted next run.
 */
function saveAccount(accountUrl: string, scope: "global" | "project"): void {
  try {
    saveOpConfigAccount(accountUrl, scope);
  } catch {
    // Non-fatal — the account is still used for THIS run via the returned auth.
  }
}

/** Ask whether to save the picked account globally or for this project only. */
async function pickSaveScope(): Promise<"global" | "project"> {
  const { createInterface } = await import("node:readline");
  process.stderr.write(
    "\n[claudish] Remember this account for:\n" +
      "  1) all projects (global ~/.claudish/config.json)  [default]\n" +
      "  2) this project only (./.claudish.json)\n"
  );
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Scope [1-2]: ", (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
  return answer === "2" ? "project" : "global";
}

/** Interactive multi-account picker (only invoked when stdout is a TTY). */
async function pickOnepasswordAccount(accounts: AccountInfo[]): Promise<string | undefined> {
  const { createInterface } = await import("node:readline");
  process.stderr.write("\n[claudish] Multiple 1Password accounts found. Choose one:\n");
  accounts.forEach((a, i) => {
    process.stderr.write(`  ${i + 1}) ${a.url}${a.email ? `  (${a.email})` : ""}\n`);
  });
  const answer = await new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Account [1-${accounts.length}]: `, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
  const idx = Number.parseInt(answer, 10);
  if (Number.isNaN(idx) || idx < 1 || idx > accounts.length) {
    process.stderr.write("[claudish] No valid selection — aborting 1Password account picker.\n");
    return undefined;
  }
  return accounts[idx - 1].url;
}

/**
 * Resolve SDK auth at most once per process. Multi-account users are prompted at
 * most once (and the choice is saved to config). The interactive picker is only
 * offered when `allowPrompt` is set AND stdout is a TTY AND we're not in --stdin
 * mode — so MCP/serve (non-TTY) never block on a prompt.
 *
 * On failure: throws OpAuthError. The caller decides whether that's fatal
 * (explicit flag) or a soft "provider unavailable" (config-driven routing).
 */
async function getSdkAuth(allowPrompt: boolean): Promise<SdkAuth | undefined> {
  if (sdkAuthResolved) return cachedSdkAuth;
  // In-flight dedup: concurrent callers (e.g. the model selector resolving 16
  // providers at once) share ONE auth resolution. Without this, a second caller
  // arriving while the first awaits would see a half-set latch and get undefined
  // auth → spurious "no account" failures. The Promise is the single source of
  // truth until it settles.
  if (authInFlight) return authInFlight;

  authInFlight = (async () => {
    const { resolveSdkAuth } = await import("../../providers/onepassword.js");
    const interactive =
      allowPrompt && Boolean(process.stdout.isTTY) && !process.argv.includes("--stdin");
    try {
      // Startup-trace: auth resolution may run `op account list` and, for a
      // multi-account user, an INTERACTIVE picker — hence mayIncludeUserPrompt.
      const auth = await traceSpan(
        "op:auth-resolve",
        () =>
          resolveSdkAuth({
            configAccount: readOnepasswordAccount(),
            interactive,
            onNeedsPicker: async (accounts) => {
              const chosen = await pickOnepasswordAccount(accounts);
              if (chosen) {
                const scope = await pickSaveScope();
                saveAccount(chosen, scope);
              }
              return chosen;
            },
          }),
        { mayIncludeUserPrompt: true, interactive }
      );
      cachedSdkAuth = auth;
      sdkAuthResolved = true;
      return auth;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpAuthError(message);
    } finally {
      authInFlight = undefined;
    }
  })();

  return authInFlight;
}

/** Test-only: reset the memoized auth latch. */
export function __resetSdkAuthForTests(): void {
  cachedSdkAuth = undefined;
  sdkAuthResolved = false;
  authInFlight = undefined;
}

/**
 * Public auth accessor for the EXPLICIT-flag callers (--op / --op-env) in
 * index.ts. These are direct user intent, so they prompt (allowPrompt=true) and
 * a failure throws OpAuthError (hard-fail). Memoized once per process.
 */
export function resolveExplicitFlagAuth(): Promise<SdkAuth | undefined> {
  return getSdkAuth(true);
}

// ── Sync sniff: is there ANY 1Password source? ──────────────────────────────

interface SniffedConfig {
  apiKeys?: Record<string, string>;
  onepassword?: string[];
  customEndpoints?: Record<string, unknown>;
}

/**
 * Hermetic test seams (no mock.module — Bun's module mocks are process-global
 * and bleed across sibling test files). When set, the config read, the SDK
 * client construction, and the auth resolution are all answered in-memory so
 * the resolve pipeline (single-flight glob memoization included) is testable
 * without the real ~/.claudish/config.json, the op binary, or the SDK/WASM.
 */
interface OpSourceTestSeams {
  /** Replaces the ~/.claudish/config.json read. */
  config?: SniffedConfig;
  /** Threaded into every onepassword.ts resolution call (fake SDK client). */
  sdkFactory?: SdkClientFactory;
  /** Skips getSdkAuth() entirely (no account resolution, no prompts). */
  auth?: SdkAuth;
}
let testSeams: OpSourceTestSeams | undefined;

/** Test-only: install (or clear, with undefined) the hermetic seams above. */
export function __setOpSourceSeamsForTests(seams: OpSourceTestSeams | undefined): void {
  testSeams = seams;
}

function readConfigRaw(): SniffedConfig {
  if (testSeams?.config) return testSeams.config;
  try {
    const configPath = join(homedir(), ".claudish", "config.json");
    if (!existsSync(configPath)) return {};
    return JSON.parse(readFileSync(configPath, "utf-8")) as SniffedConfig;
  } catch {
    return {};
  }
}

/**
 * Cheap SYNC check: does this run have ANY 1Password source? Reads config.json
 * (raw) + scans argv for --op/--op-env + config environments. Returns false
 * WITHOUT importing the SDK — this is the laziness gate. Memoized: the config
 * file doesn't change mid-run.
 */
let sniffed: boolean | undefined;
export function hasOpSources(): boolean {
  if (sniffed !== undefined) return sniffed;
  sniffed = computeHasOpSources();
  return sniffed;
}

function computeHasOpSources(): boolean {
  // Escape hatch: CLAUDISH_DISABLE_OP=1 forces "no op source" without touching
  // the SDK. Used by hermetic tests (so route()/isAvailable never resolve a real
  // op:// key from the host's config) and available to users who want to disable
  // 1Password for a single run. Mock-free → no cross-file test bleed.
  if (process.env.CLAUDISH_DISABLE_OP === "1") return false;

  const argv = process.argv.slice(2);
  if (
    argv.some(
      (a) => a === "--op" || a.startsWith("--op=") || a === "--op-env" || a.startsWith("--op-env=")
    )
  ) {
    return true;
  }
  if (readAllOnepasswordEnvironments().length > 0) return true;

  const cfg = readConfigRaw();
  // A single op:// ref sitting in apiKeys.
  if (cfg.apiKeys) {
    for (const v of Object.values(cfg.apiKeys)) {
      if (typeof v === "string" && v.startsWith("op://")) return true;
    }
  }
  // The dedicated onepassword[] array (globs + single refs).
  if (
    Array.isArray(cfg.onepassword) &&
    cfg.onepassword.some((e) => typeof e === "string" && e.trim().startsWith("op://"))
  ) {
    return true;
  }
  // A custom endpoint whose apiKey is an op:// ref.
  if (cfg.customEndpoints && typeof cfg.customEndpoints === "object") {
    for (const raw of Object.values(cfg.customEndpoints)) {
      if (raw && typeof raw === "object") {
        const apiKey = (raw as { apiKey?: unknown }).apiKey;
        if (typeof apiKey === "string" && apiKey.startsWith("op://")) return true;
      }
    }
  }
  return false;
}

/** Test-only: reset the sniff cache (config can change between tests). */
export function __resetSniffForTests(): void {
  sniffed = undefined;
}

// ── Per-env-var on-demand resolution ────────────────────────────────────────

// Process-wide serialization of op resolution. The 1Password SDK's WASM↔desktop
// IPC bridge is NOT safe for concurrent calls (overlapping ops corrupt the
// channel → "IPC operation failed: -4"). The model selector / config TUI resolve
// many providers AT ONCE, so we chain every resolution through this queue: at
// most one runs at a time. (Mirrors onepassword.ts's runSdkExclusive, but at the
// op-source orchestration layer so the whole resolve — discovery + secrets — is
// one critical section.)
let opQueue: Promise<unknown> = Promise.resolve();

/** Span-meta hook handed to the op body so it can annotate its own queued span
 *  (e.g. { globCacheHit: true } when the resolve was served from the shared
 *  glob cache with ~0 exec). Merged into the span at end(). */
interface OpSpanCtx {
  addMeta(m: SpanMeta): void;
}

function runOpExclusive<T>(
  op: (span: OpSpanCtx) => Promise<T>,
  label = "op:resolve",
  meta?: SpanMeta
): Promise<T> {
  // Startup-trace: this queue serializes the concurrent per-provider credential
  // resolutions (config TUI / model selector resolve ~16 providers at once), so
  // the waitMs/execMs split here is what reveals a startup queue pile-up.
  const span = beginQueuedSpan(label, meta);
  let extraMeta: SpanMeta = {};
  const ctx: OpSpanCtx = {
    addMeta(m) {
      extraMeta = { ...extraMeta, ...m };
    },
  };
  const timedOp = () => {
    span.start();
    return op(ctx);
  };
  const run = opQueue.then(timedOp, timedOp);
  run.then(
    () => span.end(extraMeta),
    (err) =>
      span.end({ ...extraMeta, error: true, errorMsg: String(err).split("\n")[0].slice(0, 120) })
  );
  // Keep the chain alive even if this op rejects (next op still runs).
  opQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Per-process cache of resolved env-var values. Once a glob is discovered and an
// env var resolved, a later provider asking for the SAME var is served from here
// — no second SDK round-trip. This is what makes the serialized 26-provider
// resolution cheap: the shared config glob is discovered ONCE.
const resolvedCache = new Map<string, string>();

// ── Single-flight + full-result memoization per GLOB ─────────────────────────
// The measured startup pathology: 26 providers each triggered a FULL glob
// resolution (vaults.list + items.list + items.get + secrets.resolveAll, ~1-2s
// exec each) against the SAME configured glob, serialized through the op queue
// → ~34s of redundant re-discovery. Fix: the FIRST resolve of a glob runs ONE
// full resolution (all matching env vars, batched) and memoizes the promise;
// every concurrent/subsequent caller awaits that same promise and picks its
// env vars out of the shared result. A REJECTED resolution is evicted from the
// map so the next request retries (failures are never cached).
const globResolutions = new Map<string, Promise<Record<string, string>>>();
// Env-var names populated by a glob resolution — lets a later cache-served
// resolve annotate its span with { globCacheHit: true } (observability only).
const globResolvedVars = new Set<string>();

/**
 * Mask a glob for a trace-span label: vault + pattern kept, long item titles
 * mid-truncated. Vault/item TITLES are allowed in spans (they already appear in
 * stderr warnings) — this only bounds the label length; field VALUES never
 * appear anywhere near here.
 */
function maskGlobForTrace(globPath: string): string {
  const body = globPath.startsWith("op://") ? globPath.slice("op://".length) : globPath;
  const segments = body.split("/");
  if (segments.length < 2) return globPath.slice(0, 48);
  const [vault, item, ...rest] = segments;
  const maskedItem = item.length > 20 ? `${item.slice(0, 12)}…${item.slice(-4)}` : item;
  return `op://${vault}/${maskedItem}/${rest.join("/")}`;
}

/**
 * Resolve a glob ONCE per process (single-flight + memoized full result).
 *
 *  - First caller: runs the full pipeline (discover the item ONCE, batch-resolve
 *    ALL matching env vars) inside an `op:glob-resolve(<masked glob>)` span, then
 *    populates `resolvedCache` with EVERY resolved var so later point-of-need
 *    resolves (post-startup, TUI) are pure cache hits.
 *  - Concurrent/subsequent callers: await the SAME promise ({ cacheHit: true }).
 *  - Failure: the promise is evicted from the map → the next request retries.
 *    (An EMPTY result is a success — memoized — matching the old non-throwing
 *    "this glob holds none of the wanted keys" semantics.)
 */
async function resolveGlobShared(
  globPath: string,
  auth: SdkAuth | undefined
): Promise<{ resolved: Record<string, string>; cacheHit: boolean }> {
  const existing = globResolutions.get(globPath);
  if (existing) return { resolved: await existing, cacheHit: true };

  const spanName = `op:glob-resolve(${maskGlobForTrace(globPath)})`;
  const promise = (async () => {
    const { resolveGlobImportAll, recordOpHydratedVars } = await import(
      "../../providers/onepassword.js"
    );
    // The warn sink surfaces per-field diagnostics (duplicate titles, an
    // unresolvable field like a `tooManyMatchingFields` duplicate label). The
    // resolution runs ONCE per process, so these print at most once per launch.
    const resolved = await traceSpan(spanName, () =>
      resolveGlobImportAll(globPath, {
        auth,
        sdkFactory: testSeams?.sdkFactory,
        warn: (m) => console.error(m),
      })
    );
    addSpanMeta(spanName, { vars: Object.keys(resolved).length });
    // Populate the shared value cache with EVERYTHING the glob holds, and record
    // provenance so the TUI/--probe show "From: 1Password" for cache-served vars.
    for (const [k, v] of Object.entries(resolved)) {
      resolvedCache.set(k, v);
      globResolvedVars.add(k);
    }
    recordOpHydratedVars(Object.keys(resolved));
    return resolved;
  })();
  globResolutions.set(globPath, promise);
  // Failed resolutions must NOT be memoized: evict so the next caller retries.
  promise.catch(() => {
    if (globResolutions.get(globPath) === promise) globResolutions.delete(globPath);
  });
  return { resolved: await promise, cacheHit: false };
}

/**
 * Drop every memoized op resolution (resolved values, per-glob full results,
 * and the op-source sniff). Called by the TUI after a 1Password add/edit
 * (hydrate-on-add) so item edits are re-discovered without restarting claudish.
 * Process-lifetime in-memory caches only — nothing on disk to clear.
 */
export function invalidateOpResolutionCache(): void {
  resolvedCache.clear();
  globResolutions.clear();
  globResolvedVars.clear();
  // The config just changed (e.g. FIRST-ever glob added) — re-sniff on next use.
  sniffed = undefined;
}

/** Test-only: clear the resolved-value cache, the glob memoization + the queue. */
export function __resetResolveCacheForTests(): void {
  resolvedCache.clear();
  globResolutions.clear();
  globResolvedVars.clear();
  opQueue = Promise.resolve();
}

/**
 * Resolve ONLY the requested env-var names from 1Password. The authority calls
 * this when a provider's key is missing from env/config/oauth-file. Single refs
 * and custom-endpoint op:// keys are resolved for the WANTED names only; a
 * config GLOB is full-resolved ONCE per process (single-flight, all matching
 * env vars batched) and every caller picks its wanted names from that shared
 * result — see resolveGlobShared.
 *
 * Returns `{ envVar: value }` for whatever was found (possibly empty). Never
 * mutates process.env — the caller (authority) owns the write-through mirror.
 * Resolution is SERIALIZED process-wide (the SDK IPC bridge is not concurrency-
 * safe) and CACHED per env var (so the shared config glob is discovered once).
 *
 * `onAuthFailure`:
 *   - "throw": propagate OpAuthError (explicit-flag callers).
 *   - "skip":  swallow OpAuthError → return {} (config-driven routing: the
 *     provider just resolves as unavailable, server stays up).
 */
export async function resolveOpKeyForEnvVars(
  wanted: Set<string>,
  opts: { onAuthFailure?: OnAuthFailure; allowPrompt?: boolean } = {}
): Promise<Record<string, string>> {
  if (wanted.size === 0) return {};

  // Serve any already-resolved wanted vars from cache; only the rest need the SDK.
  const cached: Record<string, string> = {};
  const stillWanted = new Set<string>();
  for (const w of wanted) {
    const hit = resolvedCache.get(w);
    if (hit !== undefined) cached[w] = hit;
    else stillWanted.add(w);
  }
  if (stillWanted.size === 0) return cached;

  // Everything below runs inside the serialized critical section. The span
  // label carries the wanted env-var NAMES (names only — never values).
  const label = `op:resolve(${[...stillWanted].sort().join(",")})`;
  return runOpExclusive(async (span) => {
    // Re-check the cache inside the lock: a prior queued op may have resolved our
    // var while we waited (the shared-glob case — the whole point of caching).
    const out: Record<string, string> = { ...cached };
    const wantNow = new Set<string>();
    let servedFromGlob = false;
    for (const w of stillWanted) {
      const hit = resolvedCache.get(w);
      if (hit !== undefined) {
        out[w] = hit;
        if (globResolvedVars.has(w)) servedFromGlob = true;
      } else {
        wantNow.add(w);
      }
    }
    // Observability: this resolve was satisfied by a PRIOR caller's shared glob
    // resolution — the span shows ~0 exec with { globCacheHit: true }.
    if (servedFromGlob) span.addMeta({ globCacheHit: true });
    if (wantNow.size === 0) return out;
    const resolved = await resolveOpKeyForEnvVarsInner(wantNow, opts, span);
    for (const [k, v] of Object.entries(resolved)) {
      resolvedCache.set(k, v);
      out[k] = v;
    }
    return out;
  }, label);
}

/** The actual resolution body (runs inside runOpExclusive). */
async function resolveOpKeyForEnvVarsInner(
  wanted: Set<string>,
  opts: { onAuthFailure?: OnAuthFailure; allowPrompt?: boolean } = {},
  span?: OpSpanCtx
): Promise<Record<string, string>> {
  if (wanted.size === 0) return {};
  if (!hasOpSources()) return {};

  const onAuthFailure = opts.onAuthFailure ?? "skip";
  const allowPrompt = opts.allowPrompt ?? false;

  let auth: SdkAuth | undefined;
  if (testSeams?.auth) {
    auth = testSeams.auth;
  } else {
    try {
      auth = await getSdkAuth(allowPrompt);
    } catch (err) {
      if (err instanceof OpAuthError && onAuthFailure === "skip") {
        console.error(`[claudish] 1Password auth unavailable, skipping op:// keys: ${err.message}`);
        return {};
      }
      throw err;
    }
  }

  const { collectConfigImports, resolveSecrets, recordOpHydratedVars } = await import(
    "../../providers/onepassword.js"
  );

  const cfg = readConfigRaw();
  const out: Record<string, string> = {};

  try {
    // 1. config single op:// refs + globs (apiKeys + onepassword[]).
    const collected = collectConfigImports(
      { apiKeys: cfg.apiKeys, onepassword: cfg.onepassword },
      process.env
    );
    for (const w of collected.warnings) console.error(w);

    // Single refs whose derived env name is wanted.
    const wantedRefs: Record<string, string> = {};
    for (const [envVar, ref] of Object.entries(collected.opRefs)) {
      if (wanted.has(envVar)) wantedRefs[envVar] = ref;
    }
    if (Object.keys(wantedRefs).length > 0) {
      const resolved = await resolveSecrets(wantedRefs, {
        auth,
        sdkFactory: testSeams?.sdkFactory,
      });
      Object.assign(out, resolved);
    }

    // Globs: each glob resolves ONCE per process (single-flight + memoized full
    // result — resolveGlobShared). The first caller discovers the item ONCE and
    // batch-resolves ALL matching env vars; this caller (and every later one)
    // just picks its wanted names out of the shared result. 26 providers →
    // 1 discovery + 1 batched resolveAll instead of 26 full re-discoveries.
    const stillWanted = new Set([...wanted].filter((w) => !(w in out)));
    for (const globPath of collected.globImports) {
      if (stillWanted.size === 0) break;
      try {
        const { resolved, cacheHit } = await resolveGlobShared(globPath, auth);
        if (cacheHit) span?.addMeta({ globCacheHit: true });
        for (const w of [...stillWanted]) {
          const v = resolved[w];
          if (v !== undefined) {
            out[w] = v;
            stillWanted.delete(w);
          }
        }
      } catch (globErr) {
        // NON-FATAL (startup contract): warn + skip — a bad glob must never lock
        // the user out. The failed resolution was evicted from the memo map, so
        // the NEXT resolve retries it.
        const m = globErr instanceof Error ? globErr.message : String(globErr);
        console.error(`[claudish] 1Password import skipped: ${m}`);
      }
    }

    // 2. custom-endpoint op:// apiKeys → CUSTOM_<NAME>_KEY.
    if (cfg.customEndpoints && typeof cfg.customEndpoints === "object") {
      const customRefs: Record<string, string> = {};
      for (const [name, raw] of Object.entries(cfg.customEndpoints)) {
        if (!raw || typeof raw !== "object") continue;
        const apiKey = (raw as { apiKey?: unknown }).apiKey;
        // Use a plain op:// prefix check (NOT isOpReference, whose anchored regex
        // rejects whitespace) — real 1Password item/section titles contain spaces.
        if (typeof apiKey !== "string" || !apiKey.startsWith("op://")) continue;
        const envVar = `CUSTOM_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
        if (wanted.has(envVar) && !(envVar in out)) customRefs[envVar] = apiKey;
      }
      if (Object.keys(customRefs).length > 0) {
        const resolved = await resolveSecrets(customRefs, {
          auth,
          sdkFactory: testSeams?.sdkFactory,
        });
        Object.assign(out, resolved);
      }
    }
  } catch (err) {
    if (err instanceof OpAuthError && onAuthFailure === "skip") {
      console.error(`[claudish] 1Password resolution skipped: ${err.message}`);
      return out;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password secret resolution failed: ${message}`);
    if (onAuthFailure === "throw") throw err;
  }

  // Provenance: record which env vars came from 1Password so the config TUI /
  // --probe display "From: 1Password" instead of mislabeling them "From: env".
  if (Object.keys(out).length > 0) recordOpHydratedVars(Object.keys(out));

  return out;
}
