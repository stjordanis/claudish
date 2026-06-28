/**
 * Equivalence pin test — guards the async credential authority against routing
 * behavior drift.
 *
 * This test asserts that the credential authority's ASYNC readiness oracle
 * (`credentials.isAvailable(name)`) returns EXACTLY the same boolean as the
 * routing oracle (`hasCredentialsForProvider(name)` in routing-rules.ts, also
 * async now) AND the documented expected truth, for a matrix of representative
 * providers × non-op credential states (env / alias / config / oauth / public /
 * local). op-source is stubbed (hasOpSources → false) so the matrix stays
 * hermetic — 1Password resolution is covered by the dedicated op-source tests.
 *
 * A divergence here means the async refactor changed routing behavior.
 *
 * ── Hermetic strategy ─────────────────────────────────────────────────────────
 * `os.homedir()` cannot be re-pointed at runtime in Bun, so we cannot create a
 * fake HOME and write real oauth files there. Instead we `mock.module()` the leaf
 * functions that BOTH the new authority and the old oracle consult, driving them
 * from a single shared mutable `state`:
 *   - ../oauth-registry.js     → hasOAuthCredentials  (kimi, gemini, AND the
 *                                 oracle's openai-codex oauth branch). No
 *                                 singleton, so the mock is reliable cross-file.
 *   - ../../profile-config.js  → getApiKey, isLocalProviderEnabled  (config keys,
 *                                 local-enabled state). No singleton.
 *
 * The NEW codex path does NOT read oauth-registry — its OAuth half reads the
 * `CodexOAuth` SINGLETON's `hasCredentials()`. A `mock.module("../codex-oauth.js")`
 * is unreliable here: another test file may construct the real singleton first.
 * So we instead OVERRIDE the real singleton's `hasCredentials` method in place
 * (the authority's CodexOAuthHalf holds a reference to that same instance) and
 * restore it after. This is robust whether the file runs alone or in the suite.
 *
 * We do NOT mock node:fs: no provider in our matrix takes the oracle path
 * through `isProviderAvailable`'s existsSync branch (codex/kimi short-circuit at
 * hasOAuthCredentials; publicKeyFallback short-circuits before existsSync; no
 * buildDefault ApiKeyCredentialProvider carries an oauthFallback). The dedicated
 * oauthFallback-existsSync branch is unit-tested in authority.test.ts instead.
 *
 * Env-var state is driven directly via process.env (snapshotted + restored).
 * The real ApiKeyCredentialProvider / CompositeCredentialProvider /
 * LocalCredentialProvider / NativeAnthropicCredentialProvider classes are
 * exercised — only their leaf reads are controlled.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── Shared mutable state, consulted by every mock / override ──────────────────

interface MatrixState {
  /** Provider names for which hasOAuthCredentials() returns true. */
  oauthAuthed: Set<string>;
  /** Whether CodexOAuth.hasCredentials() returns true (new-codex path). */
  codexHasCreds: boolean;
  /** envVar -> value for the config.json apiKeys map (getApiKey). */
  configKeys: Map<string, string>;
  /**
   * Provider names enabled as local providers. These are written into the REAL
   * global config file (localProviders[]) in beforeEach — NOT mocked. See the
   * "Local providers" note below for why mocking isLocalProviderEnabled is not
   * isolation-safe.
   */
  localEnabled: Set<string>;
}

const state: MatrixState = {
  oauthAuthed: new Set(),
  codexHasCreds: false,
  configKeys: new Map(),
  localEnabled: new Set(),
};

function resetState(): void {
  state.oauthAuthed.clear();
  state.codexHasCreds = false;
  state.configKeys.clear();
  state.localEnabled.clear();
}

// ── Module mocks ──────────────────────────────────────────────────────────────
//
// `installModuleMocks()` registers the two leaf mocks that BOTH the new authority
// and the old oracle consult. It is invoked once below (so the real imports that
// follow capture the mocks).
//
// ── Local providers: NOT mocked — driven via the REAL config file ─────────────
// NOTE the deliberate ASYMMETRY: this mock no longer overrides
// `isLocalProviderEnabled`. Here's why mocking it is not isolation-safe.
//
// `authority.js` exports a `credentials` SINGLETON, built once via
// `CredentialAuthority.buildDefault()` at module-load time. Its
// LocalCredentialProvider closes over the `isLocalProviderEnabled` binding from
// `local-credential.js`. In a full-suite run, some OTHER file imports `authority.js`
// (directly, or transitively via routing-rules / proxy-server) BEFORE this file's
// `mock.module("../../profile-config.js")` runs, so the singleton — and the
// local-credential binding — are materialized against the REAL profile-config.
// Bun then serves that already-built singleton from cache to our `await import`,
// and a later `mock.module` does NOT retroactively re-point the binding inside a
// build context that has already resolved. Net effect: `isAuthenticated("ollama")`
// calls the REAL `isLocalProviderEnabled` regardless of our mock.
//
// Every OTHER provider in the matrix is decided by `process.env` (which we drive
// directly) or by the oauth-registry mock / CodexOAuth override (which target a
// no-singleton function and a method we patch in place) — those ARE isolation-safe.
// The LOCAL path is the ONLY one whose truth flows through `isLocalProviderEnabled`
// → `loadConfig()` → the real global config file. So for the local case we drive
// that SINGLE shared source directly: `seedLocalProviders()` (in beforeEach) writes
// the real ~/.claudish/config.json `localProviders[]` (backing up + restoring the
// user's real file in afterEach, the same backup/restore pattern
// handlers/default-provider-e2e.test.ts uses). BOTH the authority's
// LocalCredentialProvider AND the oracle read that one file via loadConfig(), so
// they can never diverge and the result is independent of test execution order.
// This was the only assertion that failed in the full suite; it now passes because
// it no longer depends on a mock reaching the singleton.

const realProfileConfig = await import("../../profile-config.js");
// The REAL op-source — used to reset its sync sniff after we rewrite the config.
const { __resetSniffForTests: resetOpSniff } = await import("./op-source.js");

function installModuleMocks(): void {
  mock.module("../oauth-registry.js", () => ({
    hasOAuthCredentials: (name: string) => state.oauthAuthed.has(name),
    // Preserve the OAUTH_PROVIDERS export shape in case anything reads it.
    OAUTH_PROVIDERS: {},
  }));

  mock.module("../../profile-config.js", () => ({
    ...realProfileConfig,
    getApiKey: (envVar: string) => state.configKeys.get(envVar),
    // isLocalProviderEnabled is intentionally NOT overridden — see the note above.
  }));

  // NOTE: op-source.js is deliberately NOT mocked. The authority's isAvailable()
  // consults op-source only when env/config/oauth all miss — and seedLocalProviders()
  // strips every 1Password source from the seeded config, so op-source's sync sniff
  // (hasOpSources) returns false and 1Password is never touched. Mocking op-source
  // here would bleed into sibling files (Bun's mock.module is process-global) and
  // break their REAL op-source tests in a full `bun test` run.
}

installModuleMocks();

// ── Real global-config driver for the LOCAL provider case ─────────────────────
// loadConfig() reads CONFIG_FILE (~/.claudish/config.json) fresh on every call,
// and isLocalProviderEnabled(name) === loadConfig().localProviders.includes(name).
// We back up the user's real config once (the first time we touch it), write a
// test config reflecting state.localEnabled, and restore it in afterAll.

const REAL_CONFIG_PATH = join(homedir(), ".claudish", "config.json");
let configBackup: string | null = null;
let configExistedBefore = false;
let configTouched = false;

/** Write the real global config so its localProviders[] === state.localEnabled. */
function seedLocalProviders(): void {
  if (!configTouched) {
    configExistedBefore = existsSync(REAL_CONFIG_PATH);
    configBackup = configExistedBefore ? readFileSync(REAL_CONFIG_PATH, "utf-8") : null;
    mkdirSync(dirname(REAL_CONFIG_PATH), { recursive: true });
    configTouched = true;
  }
  // Start from the real config (preserve unrelated keys) and override localProviders.
  let base: Record<string, unknown> = {};
  if (configBackup !== null) {
    try {
      base = JSON.parse(configBackup) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  base.localProviders = Array.from(state.localEnabled).sort();
  // STRIP every 1Password source from the seeded config so op-source's sync sniff
  // (hasOpSources) returns false during the matrix — the authority then never
  // consults 1Password for the "no creds → false" cases, keeping them hermetic
  // WITHOUT mocking op-source.js (which would bleed into sibling test files in a
  // full `bun test` run, since Bun's mock.module is process-global).
  delete base.onepassword;
  delete base.onepasswordEnvironments;
  // Also strip any op:// values hiding in apiKeys / customEndpoints.
  if (base.apiKeys && typeof base.apiKeys === "object") {
    for (const [k, v] of Object.entries(base.apiKeys as Record<string, unknown>)) {
      if (typeof v === "string" && v.startsWith("op://"))
        delete (base.apiKeys as Record<string, unknown>)[k];
    }
  }
  delete base.customEndpoints;
  writeFileSync(REAL_CONFIG_PATH, JSON.stringify(base, null, 2), "utf-8");
  // Reset op-source's memoized sniff so it re-reads this (op-stripped) config.
  resetOpSniff();
}

/** Restore the user's real global config exactly as it was before the suite. */
function restoreRealConfig(): void {
  if (!configTouched) return;
  if (configBackup !== null) {
    writeFileSync(REAL_CONFIG_PATH, configBackup, "utf-8");
  } else if (!configExistedBefore && existsSync(REAL_CONFIG_PATH)) {
    try {
      rmSync(REAL_CONFIG_PATH);
    } catch {}
  }
  configTouched = false;
  configBackup = null;
  configExistedBefore = false;
}

// ── Override the real CodexOAuth singleton's hasCredentials (robust cross-file) ─
//
// The new codex path reads the CodexOAuth SINGLETON's hasCredentials() (not the
// oauth-registry mock). We override that method in place. Re-applied in
// `beforeEach` too, in case another file reset/reconstructed the singleton.

const { CodexOAuth } = await import("../codex-oauth.js");
const codexSingleton = CodexOAuth.getInstance();
const realCodexHasCreds = codexSingleton.hasCredentials.bind(codexSingleton);

function installCodexOverride(): void {
  codexSingleton.hasCredentials = () => state.codexHasCreds;
}

installCodexOverride();

// ── Real impls under test (imported AFTER the mocks are registered) ───────────

const { credentials } = await import("./authority.js");
const { hasCredentialsForProvider } = await import("../../providers/routing-rules.js");

// Sanity: the oracle must be exported for the equivalence gate.
test("hasCredentialsForProvider is exported from routing-rules", async () => {
  expect(typeof hasCredentialsForProvider).toBe("function");
});

// ── Env snapshotting ──────────────────────────────────────────────────────────

const ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "OPENCODE_API_KEY",
  "OLLAMA_API_KEY",
  "GLM_API_KEY",
  "ZHIPU_API_KEY",
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  // Cross-file isolation guard: re-establish the mocks/override that CAN reliably
  // re-point (oauth-registry function + the CodexOAuth method we patch in place),
  // in case another file's `mock.restore()` ran since the last test. The local
  // path is handled separately via the real config file (see seedLocalProviders).
  installModuleMocks();
  installCodexOverride();

  for (const v of ENV_VARS) {
    savedEnv.set(v, process.env[v]);
    delete process.env[v];
  }
  resetState();

  // CRITICAL cross-file isolation: the `credentials` authority is a process
  // singleton whose ApiKeyCredentialProvider MEMOIZES each provider's resolved
  // key (cachedKey). Another test file that resolved a REAL key (e.g. via op://)
  // would leave it memoized, so our "no creds → false" cases would see the
  // stale real key and wrongly report available. invalidate() drops every
  // provider's memo so each test re-resolves against THIS test's env/config.
  credentials.invalidate();

  // Default every test to "no local providers enabled" in the REAL config, so the
  // local path's truth is deterministic and independent of the user's real config
  // and of test execution order. Local tests that need ollama enabled re-seed.
  seedLocalProviders();
});

afterEach(() => {
  for (const v of ENV_VARS) {
    const prev = savedEnv.get(v);
    if (prev === undefined) delete process.env[v];
    else process.env[v] = prev;
  }
  resetState();
});

afterAll(() => {
  codexSingleton.hasCredentials = realCodexHasCreds;
  restoreRealConfig();
  mock.restore();
});

// ── The equivalence assertion helper ──────────────────────────────────────────

/**
 * Seed a config.json apiKeys entry the way production does.
 *
 * At startup `loadStoredApiKeys()` GAP-FILLS every config `apiKeys` value into
 * process.env (env-already-set wins). So by the time routing runs, a config key
 * is ALWAYS mirrored into process.env. The OLD oracle's `isProviderAvailable`
 * reads ONLY process.env (never config.json); the NEW ApiKeyCredentialProvider
 * reads env → alias → getApiKey(config). Modeling the config-only state WITHOUT
 * the env mirror would be an artificial divergence that cannot occur at routing
 * time — so we mirror into env here, exactly as startup does.
 */
function seedConfigKey(envVar: string, value: string): void {
  state.configKeys.set(envVar, value);
  if (!process.env[envVar]) process.env[envVar] = value; // env-already-set wins
}

/**
 * Assert that the new authority and the old oracle agree for `name` in the
 * current state. `expected` documents the intended truth for readability and is
 * also asserted, so a regression in EITHER side is caught.
 */
async function assertEquivalent(name: string, expected: boolean): Promise<void> {
  // Both the authority readiness oracle and the routing oracle are now ASYNC
  // (they resolve env → config → oauth → op://). The equivalence contract is the
  // same: authority.isAvailable() must equal hasCredentialsForProvider() and the
  // documented expected truth, for every non-op credential state.
  const fromAuthority = await credentials.isAvailable(name);
  const fromOracle = await hasCredentialsForProvider(name);
  expect(fromAuthority, `authority.isAvailable(${name}) should equal oracle (${fromOracle})`).toBe(
    fromOracle
  );
  expect(fromAuthority, `authority.isAvailable(${name}) expected ${expected}`).toBe(expected);
}

// ── The matrix ────────────────────────────────────────────────────────────────

describe("credential equivalence: openrouter (plain key)", async () => {
  test("no creds → false", async () => assertEquivalent("openrouter", false));
  test("primary env key → true", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-123";
    await assertEquivalent("openrouter", true);
  });
  test("config key → true", async () => {
    seedConfigKey("OPENROUTER_API_KEY", "sk-or-cfg");
    await assertEquivalent("openrouter", true);
  });
});

describe("credential equivalence: openai (plain key)", async () => {
  test("no creds → false", async () => assertEquivalent("openai", false));
  test("primary env key → true", async () => {
    process.env.OPENAI_API_KEY = "sk-oai-123";
    await assertEquivalent("openai", true);
  });
  test("config key → true", async () => {
    seedConfigKey("OPENAI_API_KEY", "sk-oai-cfg");
    await assertEquivalent("openai", true);
  });
});

describe("credential equivalence: openai-codex (OAuth-OR-CODEX-key, OPENAI_API_KEY alias excluded)", async () => {
  test("no creds → false", async () => assertEquivalent("openai-codex", false));

  test("OPENAI_CODEX_API_KEY env → true", async () => {
    process.env.OPENAI_CODEX_API_KEY = "sk-codex-123";
    await assertEquivalent("openai-codex", true);
  });

  test("config OPENAI_CODEX_API_KEY → true", async () => {
    seedConfigKey("OPENAI_CODEX_API_KEY", "sk-codex-cfg");
    await assertEquivalent("openai-codex", true);
  });

  // The OPENAI_API_KEY alias must NOT authenticate codex (it's the proxy's
  // header key for an active codex sub, not a signal the user HAS the sub).
  test("OPENAI_API_KEY alias alone → false (excluded)", async () => {
    process.env.OPENAI_API_KEY = "sk-oai-not-codex";
    await assertEquivalent("openai-codex", false);
  });

  // OAuth credentials present (codex path): both sides must see it as authed.
  // Oracle reads hasOAuthCredentials("openai-codex"); the new authority reads the
  // CodexOAuth singleton's hasCredentials(). We drive both from the same intent.
  test("codex oauth credentials present → true", async () => {
    state.oauthAuthed.add("openai-codex"); // oracle's hasOAuthCredentials branch
    state.codexHasCreds = true; // new authority's CodexOAuth.hasCredentials path
    await assertEquivalent("openai-codex", true);
  });
});

describe("credential equivalence: gemini-codeassist (oauth-only)", async () => {
  test("no creds → false", async () => assertEquivalent("gemini-codeassist", false));
  test("oauth credentials present → true", async () => {
    state.oauthAuthed.add("gemini-codeassist");
    await assertEquivalent("gemini-codeassist", true);
  });
  // google is an alias of the gemini-codeassist credential in the authority, and
  // the oracle's hasOAuthCredentials("google") also reads gemini-oauth.json.
  test("google alias, oauth present → true", async () => {
    state.oauthAuthed.add("google");
    // For the authority, "google" routes to the gemini-codeassist provider,
    // whose isAuthenticated reads hasOAuthCredentials("gemini-codeassist").
    state.oauthAuthed.add("gemini-codeassist");
    await assertEquivalent("google", true);
  });
});

describe("credential equivalence: kimi (oauth + api-key fallback)", async () => {
  test("no creds → false", async () => assertEquivalent("kimi", false));
  test("oauth present → true", async () => {
    state.oauthAuthed.add("kimi");
    await assertEquivalent("kimi", true);
  });
  test("MOONSHOT_API_KEY env → true", async () => {
    process.env.MOONSHOT_API_KEY = "sk-moon-123";
    await assertEquivalent("kimi", true);
  });
  test("KIMI_API_KEY alias env → true", async () => {
    process.env.KIMI_API_KEY = "sk-kimi-alias";
    await assertEquivalent("kimi", true);
  });
  test("config MOONSHOT_API_KEY → true", async () => {
    seedConfigKey("MOONSHOT_API_KEY", "sk-moon-cfg");
    await assertEquivalent("kimi", true);
  });
});

describe("credential equivalence: opencode-zen (publicKeyFallback)", async () => {
  // The CRITICAL Phase-B gap: a publicKeyFallback provider is ALWAYS available
  // (isProviderAvailable returns true), even with no env/config key. The new
  // ApiKeyCredentialProvider must replicate this.
  test("no creds, publicKeyFallback → true", async () => assertEquivalent("opencode-zen", true));
  test("with env key → true", async () => {
    process.env.OPENCODE_API_KEY = "sk-zen-123";
    await assertEquivalent("opencode-zen", true);
  });
});

describe("credential equivalence: native-anthropic (dual-env)", async () => {
  test("no creds → false", async () => assertEquivalent("native-anthropic", false));
  test("ANTHROPIC_API_KEY → true", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-123";
    await assertEquivalent("native-anthropic", true);
  });
  test("ANTHROPIC_AUTH_TOKEN → true", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-ant-456";
    await assertEquivalent("native-anthropic", true);
  });
});

describe("credential equivalence: ollama (local)", async () => {
  // The local path's truth flows through the REAL global config file (see the
  // "Local providers" note above): beforeEach already seeded an empty
  // localProviders[]; tests that enable ollama re-seed via seedLocalProviders().
  test("not enabled → false", async () => assertEquivalent("ollama", false));
  test("local-enabled → true", async () => {
    state.localEnabled.add("ollama");
    seedLocalProviders(); // write localProviders:["ollama"] into the real config
    await assertEquivalent("ollama", true);
  });
  // An env key alone must NOT make a local provider routable — only the
  // explicit localProviders opt-in does.
  test("env key but not enabled → false", async () => {
    process.env.OLLAMA_API_KEY = "ignored";
    await assertEquivalent("ollama", false);
  });
});

describe("credential equivalence: qwen (empty apiKeyEnvVar, no special affordance)", async () => {
  // qwen has apiKeyEnvVar:"" and is NOT local/native/codex. buildDefault SKIPS it
  // (empty envVar) → unregistered → authority.isAuthenticated false. The oracle's
  // extra `!apiKeyEnvVar && !publicKeyFallback && !isLocal → false` guard makes it
  // false too. Both agree on false regardless of env. (NOTE: this is the ONE place
  // the routing oracle DIVERGES from the bare isProviderAvailable(def), which would
  // return true for an empty key — see the report; that's why we migrate routing to
  // the authority, not isProviderAvailable.)
  test("no creds → false (both)", async () => assertEquivalent("qwen", false));
  test("unrelated env keys present → still false", async () => {
    process.env.OPENAI_API_KEY = "sk-irrelevant";
    await assertEquivalent("qwen", false);
  });
});

describe("credential equivalence: glm (alias key)", async () => {
  test("no creds → false", async () => assertEquivalent("glm", false));
  test("primary ZHIPU_API_KEY → true", async () => {
    process.env.ZHIPU_API_KEY = "sk-zhipu";
    await assertEquivalent("glm", true);
  });
  test("GLM_API_KEY alias → true", async () => {
    process.env.GLM_API_KEY = "sk-glm-alias";
    await assertEquivalent("glm", true);
  });
});
