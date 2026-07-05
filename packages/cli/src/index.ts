#!/usr/bin/env bun

// Load .env file before anything else (quiet mode to suppress verbose output)
import { config } from "dotenv";
config({ quiet: true }); // Loads .env from current working directory

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveExplicitFlagAuth } from "./auth/credentials/op-source.js";
import { readAllOnepasswordEnvironments } from "./providers/onepassword-config.js";
import {
  beginSpan,
  finalizeStartupTrace,
  suppressStartupTraceTerminalOutput,
  traceSpan,
} from "./startup-trace.js";

// ── Startup-timing analytics (startup-trace.ts) ─────────────────────────────
// Every launch appends one JSON line to ~/.claudish/startup-metrics.jsonl; a
// >8s startup prints a one-line diagnosis; CLAUDISH_STARTUP_TRACE=1 prints the
// full phase table. The two paths with a well-defined "ready" point (config →
// pre-TUI-mount, run → proxy-up) finalize explicitly below; this exit hook is
// the fallback so every OTHER launch kind (update, login, --probe, --version,
// team, …) still writes its line at exit. Idempotent — an explicit finalize
// wins. quiet:true → the fallback never prints the slow-start stderr line
// (a management command's total isn't "startup"), but the opt-in table still
// prints. MCP/serve are excluded: they run for hours, so an at-exit total is
// process lifetime, not startup, and would pollute the metrics.
function classifyStartupKind(): string {
  const argv = process.argv.slice(2);
  const first = argv.find((a) => !a.startsWith("-"));
  if (first === "config") return "config";
  const management = new Set([
    "update",
    "init",
    "profile",
    "telemetry",
    "stats",
    "providers",
    "login",
    "logout",
    "quota",
    "usage",
  ]);
  if ((first && management.has(first)) || argv.includes("--mcp") || first === "serve") {
    return "other";
  }
  return "run";
}
process.on("exit", () => {
  const argv = process.argv.slice(2);
  const longRunningServer =
    argv.includes("--mcp") || argv.find((a) => !a.startsWith("-")) === "serve";
  if (longRunningServer) return;
  finalizeStartupTrace(classifyStartupKind(), { quiet: true });
});

// The 1Password SDK-auth resolver, the multi-account picker, and the
// config-driven hydration (loadStoredApiKeys / applyCustomEndpointOpKeys /
// hydrateOpSecrets) all moved to auth/credentials/op-source.ts in the
// async-credential-layer refactor. Config-driven op:// keys are now resolved
// ON DEMAND by the credential authority (per provider, lazy SDK) — there is no
// per-entry-point push into process.env anymore. Only the EXPLICIT --op /
// --op-env flags below still hydrate eagerly (direct user intent), and they
// share op-source's memoized auth via resolveExplicitFlagAuth().

/**
 * Highest-priority source: 1Password Environments. Two inputs, both OVERWRITE
 * anything already in process.env (and, being applied before loadStoredApiKeys,
 * also beat config apiKeys/onepassword[]):
 *  1. `--op-env <id>` flag — the ephemeral, inline form.
 *  2. `onepasswordEnvironments[]` config — the persisted form (local + global,
 *     deduped). The flag's environment (when present) is applied LAST so an
 *     inline `--op-env` wins over a config one with overlapping keys.
 *
 * Runs the SDK ONLY when at least one environment source is present, so
 * non-users never touch the `op` binary OR the 1Password SDK. Async because the
 * SDK resolver is async. On any failure (including no SDK auth) this hard-fails
 * (exit 1) — every 1Password source is explicit opt-in.
 */
async function applyOpEnvironment(): Promise<void> {
  const argv = process.argv.slice(2);
  let flagEnvId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--op-env") {
      flagEnvId = argv[i + 1];
      break;
    }
    if (a.startsWith("--op-env=")) {
      flagEnvId = a.slice("--op-env=".length);
      break;
    }
  }
  if (flagEnvId !== undefined && (flagEnvId === "" || flagEnvId.startsWith("-"))) {
    console.error("[claudish] --op-env requires a 1Password Environment ID");
    process.exit(1);
  }

  // Config-persisted environments (local + global, deduped). Config IDs resolve
  // first; the inline flag (if any) is appended LAST so it wins on key overlap.
  const configEnvIds = readAllOnepasswordEnvironments();
  const envIds = [...configEnvIds];
  if (flagEnvId !== undefined && flagEnvId !== "") envIds.push(flagEnvId);

  // No environment source at all → zero cost, never invoke `op` or import the SDK.
  if (envIds.length === 0) return;

  try {
    // Dynamic import: only pull in the onepassword resolution path (and the SDK)
    // when an environment source is actually present.
    const { readEnvironment, recordOpHydratedVars } = await import("./providers/onepassword.js");
    const auth = await resolveExplicitFlagAuth();
    for (const envId of envIds) {
      const vars = await readEnvironment(envId, { auth });
      for (const [key, value] of Object.entries(vars)) {
        // Environments are the highest-priority source: overwrite unconditionally.
        process.env[key] = value;
      }
      recordOpHydratedVars(Object.keys(vars));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password Environment load failed: ${message}`);
    process.exit(1);
  }
}

/**
 * Inline 1Password glob import via the `--op <glob>` early-hydration flag.
 * Mirrors `applyOpEnvironment()`: scans argv BEFORE the subcommand router runs,
 * resolves the glob, and hydrates process.env so `--op` composes with EVERY
 * downstream path (config TUI, serve, a model run, plain interactive) with zero
 * special handoff.
 *
 * Two modes, selected by a bare `--list` token in the same argv:
 *  - `--op <glob> --list`  → PREVIEW: print the field-name table (no values),
 *    then exit 0. Terminal — never continues to a session or dispatch.
 *  - `--op <glob>`         → hydrate env vars (OVERWRITE — explicit inline
 *    request, like --op-env), then RETURN so execution falls through to the
 *    normal dispatch.
 *
 * After consuming, the `--op`, its glob value, and any `--list` token are
 * REMOVED from process.argv so the downstream router + parseArgs never see them
 * (critically, so the glob value isn't mistaken for the first positional arg).
 *
 * Runs only when `--op` is present, so non-users never import onepassword/SDK.
 * Hard-fails (exit 1) on any resolution/preview failure — `--op` is explicit
 * opt-in.
 */
async function applyOpImport(): Promise<void> {
  const argv = process.argv.slice(2);
  const { parseOpFlag } = await import("./providers/onepassword.js");
  const parsed = parseOpFlag(argv);

  // Flag not present → zero cost, never invoke `op` or import the SDK/command.
  if (!parsed.present) return;

  if (parsed.glob === undefined) {
    console.error("[claudish] --op requires an op:// glob path");
    process.exit(1);
  }
  const glob = parsed.glob;

  if (parsed.list) {
    // PREVIEW — names only, terminal. Never resolves secret values, never
    // continues to dispatch.
    try {
      const { opPreviewCommand } = await import("./onepassword-command.js");
      const auth = await resolveExplicitFlagAuth();
      await opPreviewCommand(glob, { auth });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[claudish] 1Password --op preview failed: ${message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // HYDRATE — resolve the glob and OVERWRITE each {envVar: value} into the
  // process env (explicit inline request, same as --op-env). Then strip the flag
  // tokens from process.argv and fall through to the normal dispatch.
  try {
    const { resolveGlobImport, recordOpHydratedVars } = await import("./providers/onepassword.js");
    const auth = await resolveExplicitFlagAuth();
    const resolved = await resolveGlobImport(glob, { auth });
    for (const [key, value] of Object.entries(resolved)) {
      process.env[key] = value;
    }
    recordOpHydratedVars(Object.keys(resolved));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claudish] 1Password --op import failed: ${message}`);
    process.exit(1);
  }

  // Remove the consumed flag tokens so downstream firstPositional detection /
  // parseArgs never see them. We drop: `--op` + its glob value, OR `--op=<glob>`.
  // (No `--list` here — list mode already exited above.)
  const head = process.argv.slice(0, 2);
  const rebuilt: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--op") {
      // Skip `--op` and its following value (the glob).
      i++;
      continue;
    }
    if (a.startsWith("--op=")) {
      continue; // inline form — single token
    }
    rebuilt.push(a);
  }
  process.argv = [...head, ...rebuilt];
}

// Early-hydration sequence (all async — the SDK is async). Both explicit flags
// beat config; config only fills remaining gaps:
//   1. --op-env <id>           — highest priority, overwrites unconditionally.
//   2. --op <glob>             — explicit inline import, also overwrites; in
//      --list mode it previews and exits before any dispatch.
//   3. config.json apiKeys/onepassword[] — gap-fill (never overwrites a set var).
//   4. customEndpoints op:// apiKeys     — pre-resolved into CUSTOM_<NAME>_KEY.
// Run to completion BEFORE the subcommand dispatch so process.env is fully
// hydrated. When none of these flags/refs are present, each returns immediately
// without importing the 1Password SDK. SDK auth is resolved AT MOST once and
// shared across all four (getSdkAuth memoization).
//
// These four are LAZY BY NEED: each inspects its source (the --op-env / --op
// flags, then config.json's op:// refs + glob imports, then custom-endpoint
// op:// keys) and returns IMMEDIATELY when there is nothing to resolve — without
// importing the 1Password SDK or its ~10MB WASM. So a user who doesn't use
// 1Password at all pays nothing here. The SDK + WASM load only at the moment a
// key is actually resolved, inside the sdkLoader (providers/onepassword.ts).
//
// Hydration is split by WHO asked:
//
//  - EXPLICIT FLAGS (--op-env / --op) are direct user intent and self-terminate
//    (--op --list previews and exits; a bare --op import applies then exits), so
//    they run EAGERLY here. Both are zero-cost when their flag is absent (they
//    read argv and return immediately), so a flagless management command pays
//    nothing.
//
//  - CONFIG-DRIVEN sources (config.json `onepassword[]` globs + apiKeys, and
//    custom-endpoint op:// keys) are ONLY needed by commands that actually route
//    a model and read a provider key from process.env: the proxy/CLI path
//    (runCli), the MCP server, and `serve`. Management subcommands — update,
//    init, profile, config, telemetry, stats, providers, login/logout, quota,
//    help, version — never use a provider key, so they must NOT trigger
//    1Password (no auth prompt, no SDK, no WASM, no glob expansion). We DEFER
//    those into hydrateOpSecrets() and call it ONLY from the routing paths
//    (an allowlist), instead of resolving for every command and trying to
//    deny-list the rest.
await traceSpan("startup:op-env-flags", () => applyOpEnvironment());
await traceSpan("startup:op-import-flag", () => applyOpImport());

// Check for MCP mode before loading heavy dependencies
const isMcpMode = process.argv.includes("--mcp");

// Handle Ctrl+C gracefully during interactive prompts
function handlePromptExit(err: unknown): void {
  if (err && typeof err === "object" && "name" in err && err.name === "ExitPromptError") {
    console.log("");
    process.exit(0);
  }
  throw err;
}

// Check for auth and profile management commands
const args = process.argv.slice(2);

// Check for subcommands (can appear anywhere in args due to aliases like `claudish -y`)
const isUpdateCommand = args.includes("update");
const isInitCommand = args[0] === "init" || args.includes("init");
const isProfileCommand =
  args[0] === "profile" ||
  args.some((a, i) => a === "profile" && (i === 0 || !args[i - 1]?.startsWith("-")));
// Find first positional (non-flag) arg — handles aliases like `claudish -y config`
const firstPositional = args.find((a) => !a.startsWith("-"));
// Check for telemetry management subcommand
const isTelemetryCommand = firstPositional === "telemetry";
// Check for stats management subcommand
const isStatsCommand = firstPositional === "stats";
// Check for interactive config TUI
const isConfigCommand = firstPositional === "config";
// Serve subcommand: claudish serve --port <n> --models <path> (Claude Desktop redirect gateway)
const isServeCommand = firstPositional === "serve";
// Providers subcommand: claudish providers --json (credential presence, no key material)
const isProvidersCommand = firstPositional === "providers";
// Auth subcommands: claudish login [provider], claudish logout [provider]
const isLoginCommand = firstPositional === "login";
const isLogoutCommand = firstPositional === "logout";
// Quota subcommand: claudish quota [provider]
const isQuotaCommand = firstPositional === "quota" || firstPositional === "usage";
// Legacy auth flags (deprecated, redirect to new subcommands)
const isLegacyGeminiLogin = args.includes("--gemini-login");
const isLegacyGeminiLogout = args.includes("--gemini-logout");
const isLegacyKimiLogin = args.includes("--kimi-login");
const isLegacyKimiLogout = args.includes("--kimi-logout");

if (isMcpMode) {
  // MCP server mode - dynamic import to keep CLI fast. Provider keys (incl.
  // op://) are resolved ON DEMAND by the credential authority when a tool routes
  // a model — no startup hydration, so the server can never die at boot on a
  // multi-account 1Password ambiguity.
  import("./mcp-server.js").then((mcp) => mcp.startMcpServer());
} else if (isServeCommand) {
  // Standalone inference gateway for Claude Desktop redirect:
  // claudish serve --port <n> --models <path>. Keys resolve on demand per route.
  const serveArgIndex = args.indexOf("serve");
  import("./serve-command.js").then((m) =>
    m.serveCommand(args.slice(serveArgIndex + 1)).catch((e) => {
      console.error(`[claudish serve] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    })
  );
} else if (isProvidersCommand) {
  // Provider credential presence (no key material): claudish providers --json
  const json = args.includes("--json");
  import("./providers-command.js").then((m) =>
    m.providersCommand({ json }).catch((e) => {
      console.error(`[claudish providers] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    })
  );
} else if (isLoginCommand) {
  // Auth login subcommand: claudish login [provider]
  const loginProviderArg = args.find((a, i) => i > args.indexOf("login") && !a.startsWith("-"));
  import("./auth/auth-commands.js").then((m) =>
    m.loginCommand(loginProviderArg).catch(handlePromptExit)
  );
} else if (isLogoutCommand) {
  // Auth logout subcommand: claudish logout [provider]
  const logoutProviderArg = args.find((a, i) => i > args.indexOf("logout") && !a.startsWith("-"));
  import("./auth/auth-commands.js").then((m) =>
    m.logoutCommand(logoutProviderArg).catch(handlePromptExit)
  );
} else if (isLegacyGeminiLogin || isLegacyKimiLogin) {
  // Deprecated --*-login flags — redirect to new subcommands
  const provider = isLegacyGeminiLogin ? "gemini" : "kimi";
  console.log(`Note: --${provider}-login is deprecated. Use: claudish login ${provider}`);
  import("./auth/auth-commands.js").then((m) => m.loginCommand(provider).catch(handlePromptExit));
} else if (isLegacyGeminiLogout || isLegacyKimiLogout) {
  // Deprecated --*-logout flags — redirect to new subcommands
  const provider = isLegacyGeminiLogout ? "gemini" : "kimi";
  console.log(`Note: --${provider}-logout is deprecated. Use: claudish logout ${provider}`);
  import("./auth/auth-commands.js").then((m) => m.logoutCommand(provider).catch(handlePromptExit));
} else if (isQuotaCommand) {
  // Quota/usage subcommand: claudish quota [provider]
  const quotaProviderArg = args.find(
    (a, i) => i > args.indexOf(firstPositional!) && !a.startsWith("-")
  );
  import("./auth/quota-command.js").then((m) => m.quotaCommand(quotaProviderArg));
} else if (isUpdateCommand) {
  // Self-update command (checked early to work with aliases like `claudish -y update`)
  import("./update-command.js").then((m) => m.updateCommand());
} else if (isInitCommand) {
  // Profile setup wizard — pass --local/--global scope flag if provided
  const scopeFlag = args.includes("--local")
    ? "local"
    : args.includes("--global")
      ? "global"
      : undefined;
  import("./profile-commands.js").then((pc) => pc.initCommand(scopeFlag).catch(handlePromptExit));
} else if (isProfileCommand) {
  // Profile management commands
  const profileArgIndex = args.findIndex((a) => a === "profile");
  import("./profile-commands.js").then((pc) =>
    pc.profileCommand(args.slice(profileArgIndex + 1)).catch(handlePromptExit)
  );
} else if (isTelemetryCommand) {
  // Telemetry management: claudish telemetry on|off|status|reset
  const subcommand = args[1] ?? "status";
  import("./telemetry.js").then((tel) => {
    tel.initTelemetry({ interactive: true } as any);
    return tel.handleTelemetryCommand(subcommand);
  });
} else if (isStatsCommand) {
  // Stats management: claudish stats on|off|status|reset
  const subcommand = args[1] ?? "status";
  import("./stats.js").then((stats) => {
    stats.initStats({ interactive: true } as any);
    return stats.handleStatsCommand(subcommand);
  });
} else if (isConfigCommand) {
  // Interactive configuration TUI: claudish config (full-screen btop-inspired TUI).
  //
  // The Providers screen reads readiness SYNCHRONOUSLY from process.env, but a
  // 1Password glob (op://Vault/Item/**) hides which env vars it contains until
  // resolved. So before mounting, resolve EACH known provider's credentials
  // through the credential authority concurrently — each call pulls that
  // provider's op:// key on demand (lazy SDK) and writes it through to
  // process.env. This is the on-demand path (no "resolve everything" glob pass);
  // it's a zero-cost no-op when no 1Password source exists. allowOpPrompt lets
  // the (TTY) config TUI prompt for a multi-account pick if needed.
  //
  // Startup-trace ORDERING: finalizeStartupTrace runs AFTER credential
  // resolution but BEFORE startConfigTui() mounts the OpenTUI fullscreen — the
  // slow-start line / trace table must hit stderr before the TUI owns the
  // screen, or they'd corrupt the render buffer.
  traceSpan("startup:tui-import", () => import("./tui/index.js")).then(async (m) => {
    const { credentials } = await import("./auth/credentials/authority.js");
    const { PROVIDERS } = await import("./tui/providers.js");
    await traceSpan(
      "startup:credential-resolution",
      () =>
        Promise.all(
          PROVIDERS.map((p) => credentials.isAvailable(p.catalogName, { allowOpPrompt: true }))
        ),
      { providers: PROVIDERS.length }
    );
    finalizeStartupTrace("config");
    // From here the OpenTUI fullscreen owns the terminal: NO trace line may hit
    // it (a live-printed span under CLAUDISH_STARTUP_TRACE=1 overwrites TUI
    // rows). Spans emitted during the TUI session are still buffered and, with
    // --debug, mirrored to the log file. The finalize table/slow-line above
    // already printed pre-mount, so nothing user-visible is lost.
    suppressStartupTraceTerminalOutput();
    return m.startConfigTui().catch(handlePromptExit);
  });
} else {
  // CLI mode
  runCli();
}

/**
 * Run CLI mode
 */
async function runCli() {
  const endImports = beginSpan("startup:cli-imports");
  const { checkClaudeInstalled, runClaudeWithProxy } = await import("./claude-runner.js");
  const { parseArgs, getVersion } = await import("./cli.js");
  const { DEFAULT_PORT_RANGE } = await import("./config.js");
  const { selectModel, promptForApiKey } = await import("./model-selector.js");
  const {
    resolveModelProvider,
    validateApiKeysForModels,
    getMissingKeyResolutions,
    getMissingKeysError,
  } = await import("./providers/provider-resolver.js");
  const { initLogger, getLogFilePath, getAlwaysOnLogPath, setDiagOutput } = await import(
    "./logger.js"
  );
  const { createDiagOutput } = await import("./diag-output.js");
  const { findAvailablePort } = await import("./port-manager.js");
  const { createProxyServer } = await import("./proxy-server.js");
  const { checkForUpdates } = await import("./update-checker.js");
  const { warmCatalogIfNeeded } = await import("./launcher/catalog-warm.js");
  endImports();

  /**
   * Read content from stdin
   */
  async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  try {
    // Parse CLI arguments (includes profile/config load; terminal flags like
    // --version/--models/--probe exit inside — the exit-hook fallback covers them)
    const cliConfig = await traceSpan("startup:parse-args", () => parseArgs(process.argv.slice(2)));

    // Team mode: run models in parallel (skip normal Claude Code path)
    if (cliConfig.team && cliConfig.team.length > 0) {
      // Resolve prompt: --file flag, or positional args from claudeArgs
      let prompt = cliConfig.claudeArgs.join(" ");
      if (cliConfig.inputFile) {
        prompt = readFileSync(cliConfig.inputFile, "utf-8");
      }
      if (!prompt.trim()) {
        console.error("Error: --team requires a prompt (positional args or -f <file>)");
        process.exit(1);
      }

      const mode = cliConfig.teamMode ?? "default";
      const sessionPath = join(process.cwd(), `.claudish-team-${Date.now()}`);

      if (mode === "json") {
        // JSON mode: run models without grid, collect JSON output to stdout
        const { setupSession, runModels } = await import("./team-orchestrator.js");
        setupSession(sessionPath, cliConfig.team, prompt);
        const status = await runModels(sessionPath, {
          timeout: 300,
          claudeFlags: ["--json"],
        });

        // Build JSON result with model responses included
        const result: Record<string, unknown> = { ...status, responses: {} };
        for (const anonId of Object.keys(status.models)) {
          const responsePath = join(sessionPath, `response-${anonId}.md`);
          try {
            const raw = readFileSync(responsePath, "utf-8").trim();
            try {
              (result.responses as Record<string, unknown>)[anonId] = JSON.parse(raw);
            } catch {
              (result.responses as Record<string, unknown>)[anonId] = raw;
            }
          } catch {
            (result.responses as Record<string, unknown>)[anonId] = null;
          }
        }
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      }

      // Default or interactive mode — both use magmux grid
      const { runWithGrid } = await import("./team-grid.js");
      const keep = cliConfig.teamKeep ?? false;
      const status = await runWithGrid(sessionPath, cliConfig.team, prompt, {
        timeout: 300,
        keep,
        mode: mode as "default" | "interactive",
      });

      // Print final status (interactive may not reach here until user quits magmux)
      const modelIds = Object.keys(status.models).sort();
      console.log("\nTeam Status");
      for (const id of modelIds) {
        const m = status.models[id];
        const duration =
          m.startedAt && m.completedAt
            ? `${Math.round((new Date(m.completedAt).getTime() - new Date(m.startedAt).getTime()) / 1000)}s`
            : "pending";
        console.log(`  ${id}  ${m.state.padEnd(10)}  ${duration}`);
      }
      process.exit(0);
    }

    // First-run auto-approve confirmation
    // Auto-approve is enabled by default, but on first run we confirm with the user.
    // If user explicitly passed --no-auto-approve, skip the prompt entirely.
    // If --stdin is set, skip the prompt — no human to confirm when piping input.
    const rawArgs = process.argv.slice(2);
    const explicitNoAutoApprove = rawArgs.includes("--no-auto-approve");
    if (cliConfig.autoApprove && !explicitNoAutoApprove && !cliConfig.stdin) {
      const { loadConfig, saveConfig } = await import("./profile-config.js");
      try {
        const cfg = loadConfig();
        if (!cfg.autoApproveConfirmedAt) {
          // First run — show one-time confirmation (human wait: traced so a
          // slow first launch is attributable to this prompt, not claudish).
          const endConfirm = beginSpan("startup:first-run-confirm", {
            mayIncludeUserPrompt: true,
          });
          const { createInterface } = await import("node:readline");
          process.stderr.write(
            "\n[claudish] Auto-approve is enabled by default.\n" +
              "  This skips Claude Code permission prompts for tools like Bash, Read, Write.\n" +
              "  You can disable it anytime with: --no-auto-approve\n\n"
          );
          const answer = await new Promise<string>((resolve) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            rl.question("Enable auto-approve? [Y/n] ", (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            });
          });
          const declined = answer === "n" || answer === "no";
          if (declined) {
            cliConfig.autoApprove = false;
            process.stderr.write("[claudish] Auto-approve disabled. Use -y to enable per-run.\n\n");
          } else {
            process.stderr.write("[claudish] Auto-approve confirmed.\n\n");
          }
          cfg.autoApproveConfirmedAt = new Date().toISOString();
          saveConfig(cfg);
          endConfirm();
        }
      } catch {
        // Config read/write failure — proceed with default (auto-approve on)
      }
    }

    // Initialize logger: always-on structural logging + optional debug logging
    initLogger(cliConfig.debug, cliConfig.logLevel, cliConfig.noLogs);

    // Initialize telemetry (reads consent, generates session_id)
    // Must come after parseArgs() so cliConfig.interactive is known
    const { initTelemetry } = await import("./telemetry.js");
    initTelemetry(cliConfig);

    // Initialize anonymous usage stats (reads consent, detects environment)
    const { initStats, showMonthlyBanner } = await import("./stats.js");
    initStats(cliConfig);
    showMonthlyBanner();

    // Show debug log location if enabled
    if (cliConfig.debug && !cliConfig.quiet) {
      const logFile = getLogFilePath();
      if (logFile) {
        console.log(`[claudish] Debug log: ${logFile}`);
      }
    }

    // Check for updates (only in interactive mode, skip in JSON output mode)
    if (cliConfig.interactive && !cliConfig.jsonOutput) {
      await traceSpan("startup:update-check", () =>
        checkForUpdates(getVersion(), { quiet: cliConfig.quiet })
      );
    }

    // Check if Claude Code is installed
    if (!(await traceSpan("startup:claude-detect", () => checkClaudeInstalled()))) {
      console.error("Error: Claude Code CLI not found");
      console.error("Install it from: https://claude.com/claude-code");
      console.error("");
      console.error("Or if you have a local installation, set CLAUDE_PATH:");
      console.error("  export CLAUDE_PATH=~/.claude/local/claude");
      process.exit(1);
    }

    // Show interactive model selector ONLY when no model configuration exists
    // Skip if: explicit --model, OR profile provides tier mappings (Claude Code uses these internally)
    const hasProfileTiers =
      cliConfig.modelOpus ||
      cliConfig.modelSonnet ||
      cliConfig.modelHaiku ||
      cliConfig.modelSubagent;
    if (cliConfig.interactive && !cliConfig.monitor && !cliConfig.model && !hasProfileTiers) {
      // Human wait (the interactive picker) + per-provider credential probes.
      cliConfig.model = (await traceSpan(
        "startup:model-select",
        () => selectModel({ freeOnly: cliConfig.freeOnly }).catch(handlePromptExit),
        { mayIncludeUserPrompt: true }
      )) as string;
      console.log(""); // Empty line after selection
    }

    // In non-interactive mode, model must be specified (via --model, env var, or profile)
    if (!cliConfig.interactive && !cliConfig.monitor && !cliConfig.model && !hasProfileTiers) {
      console.error("Error: Model must be specified in non-interactive mode");
      console.error("Use --model <model> flag, set CLAUDISH_MODEL env var, or use --profile");
      console.error("Try: claudish --models");
      process.exit(1);
    }

    // === API Key Validation ===
    // This happens AFTER model selection so we know exactly which provider(s) are being used
    // The centralized ProviderResolver handles all provider detection and key requirements
    if (!cliConfig.monitor) {
      // When --model is explicitly set, it overrides ALL role mappings (opus/sonnet/haiku/subagent)
      // So we only need to validate the explicit model, not the profile mappings
      const hasExplicitModel = typeof cliConfig.model === "string";

      // Collect models to validate
      const modelsToValidate = hasExplicitModel
        ? [cliConfig.model] // Only validate the explicit model
        : [
            cliConfig.model,
            cliConfig.modelOpus,
            cliConfig.modelSonnet,
            cliConfig.modelHaiku,
            cliConfig.modelSubagent,
          ];

      // === API-key validation (1Password resolved on demand, point of need) ===
      // validateApiKeysForModels is async and pulls from 1Password ITSELF for any
      // routed model whose key is missing — seeking ONLY that model's env var,
      // through the single op-source seam (lazy SDK). So:
      //   - ollama@... / any keyless model       → no key needed → no 1Password
      //   - a key already in process.env         → not missing → no 1Password
      //   - a missing key an op:// source supplies → resolved + written to env
      // parseArgs has already exited terminal flags, so --version etc. never
      // reach here at all (laziness preserved without an ordering chokepoint).
      const resolutions = await traceSpan(
        "startup:validate-api-keys",
        () => validateApiKeysForModels(modelsToValidate),
        { models: modelsToValidate.filter((m) => typeof m === "string").length }
      );
      const missingKeys = getMissingKeyResolutions(resolutions);

      if (missingKeys.length > 0) {
        if (cliConfig.interactive) {
          // Interactive mode: prompt for missing OpenRouter key if that's what's needed
          const needsOpenRouter = missingKeys.some((r) => r.category === "openrouter");
          if (needsOpenRouter && !cliConfig.openrouterApiKey) {
            cliConfig.openrouterApiKey = await promptForApiKey();
            console.log(""); // Empty line after input

            // Re-validate after getting the key (it's now in process.env)
            process.env.OPENROUTER_API_KEY = cliConfig.openrouterApiKey;
          }

          // Check if there are still missing keys (non-OpenRouter providers)
          const stillMissing = getMissingKeyResolutions(
            await validateApiKeysForModels(modelsToValidate)
          );
          const nonOpenRouterMissing = stillMissing.filter((r) => r.category !== "openrouter");

          if (nonOpenRouterMissing.length > 0) {
            // Can't prompt for other providers - show error
            console.error(getMissingKeysError(nonOpenRouterMissing));
            process.exit(1);
          }
        } else {
          // Non-interactive mode: fail with clear error message
          console.error(getMissingKeysError(missingKeys));
          process.exit(1);
        }
      }
    }

    // Clean up stdin after interactive prompts (readline, @inquirer/prompts).
    // These leave lingering data/keypress listeners and raw mode state that interfere
    // with Claude Code's TTY handling when spawned with stdio: "inherit". (#85, #88, #99)
    if (cliConfig.interactive && !cliConfig.monitor && process.stdin.isTTY) {
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("keypress");
    }

    // Show deprecation warnings for legacy syntax
    if (!cliConfig.quiet) {
      const modelsToCheck = [
        cliConfig.model,
        cliConfig.modelOpus,
        cliConfig.modelSonnet,
        cliConfig.modelHaiku,
        cliConfig.modelSubagent,
      ].filter((m): m is string => typeof m === "string");

      for (const modelId of modelsToCheck) {
        const resolution = resolveModelProvider(modelId);
        if (resolution.deprecationWarning) {
          console.warn(`[claudish] ${resolution.deprecationWarning}`);
        }
      }
    }

    // Read prompt from stdin if --stdin flag is set
    if (cliConfig.stdin) {
      // Blocks on the PIPE producer — slow here means the caller, not claudish.
      const stdinInput = await traceSpan("startup:stdin-read", () => readStdin());
      if (stdinInput.trim()) {
        // Prepend stdin content to claudeArgs
        cliConfig.claudeArgs = [stdinInput, ...cliConfig.claudeArgs];
      }
    }

    // Launcher catalog warm step. Runs BEFORE port resolution / proxy startup
    // so we can exit cleanly without a half-spawned server when the catalog
    // is missing AND the network is unreachable. See architecture.md §2.4.
    //
    // Returns one of:
    //   "ok"        — catalog ready (fresh or freshly refreshed)
    //   "warned"    — proceed with stale cache, warning already on stderr
    //   "skipped"   — local model or --models-skip-update
    //   "hard_fail" — missing cache + network failure → exit 1
    const warmOutcome = await traceSpan("startup:catalog-warm", () =>
      warmCatalogIfNeeded(cliConfig)
    );
    if (warmOutcome === "hard_fail") {
      process.exit(1);
    }

    // Find available port
    const port =
      cliConfig.port ||
      (await traceSpan("startup:find-port", () =>
        findAvailablePort(DEFAULT_PORT_RANGE.start, DEFAULT_PORT_RANGE.end)
      ));

    // Start proxy server
    // explicitModel is the default/fallback model
    // modelMap provides per-role overrides (opus/sonnet/haiku) that take priority
    const explicitModel = typeof cliConfig.model === "string" ? cliConfig.model : undefined;
    // Always pass modelMap - role mappings should work even when a default model is set
    const modelMap = {
      opus: cliConfig.modelOpus,
      sonnet: cliConfig.modelSonnet,
      haiku: cliConfig.modelHaiku,
      subagent: cliConfig.modelSubagent,
    };

    const proxy = await traceSpan("startup:proxy-start", () =>
      createProxyServer(
        port,
        cliConfig.monitor ? undefined : cliConfig.openrouterApiKey!,
        cliConfig.monitor ? undefined : explicitModel,
        cliConfig.monitor,
        cliConfig.anthropicApiKey,
        modelMap,
        {
          summarizeTools: cliConfig.summarizeTools,
          quiet: cliConfig.quiet,
          isInteractive: cliConfig.interactive,
          advisorModels: cliConfig.advisorModels,
          advisorCollector: cliConfig.advisorCollector,
        }
      )
    );

    // Route diagnostic output to log file
    const diag = createDiagOutput({
      interactive: cliConfig.interactive,
      diagMode: cliConfig.diagMode,
    });
    if (cliConfig.interactive) {
      setDiagOutput(diag);
    }

    // Startup is "ready": the proxy is up and Claude Code launches next. Print
    // any slow-start diagnosis BEFORE Claude Code takes over the terminal.
    finalizeStartupTrace("run", { quiet: cliConfig.quiet });

    // Run Claude Code with proxy
    let exitCode = 0;
    try {
      exitCode = await runClaudeWithProxy(cliConfig, proxy.url, () => diag.cleanup());
    } finally {
      // Clear diagOutput BEFORE cleanup to prevent write-after-end
      setDiagOutput(null);
      diag.cleanup();
      // Always cleanup proxy
      if (!cliConfig.quiet) {
        console.log("\n[claudish] Shutting down proxy server...");
      }
      await proxy.shutdown();
    }

    if (!cliConfig.quiet) {
      console.log("[claudish] Done\n");
    }

    // Suggest sending logs if session had errors
    const sessionLogPath = getAlwaysOnLogPath();
    if (exitCode !== 0 && sessionLogPath && !cliConfig.quiet) {
      console.error(`\n[claudish] Session ended with errors. Log: ${sessionLogPath}`);
      console.error(`[claudish] To review: /debug-logs ${sessionLogPath}`);
    }

    process.exit(exitCode);
  } catch (error) {
    console.error("[claudish] Fatal error:", error);
    console.error("[claudish] Stack:", error instanceof Error ? error.stack : "no stack");
    process.exit(1);
  }
}
