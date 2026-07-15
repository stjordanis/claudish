/**
 * Auto-update checker for Claudish
 *
 * Checks npm registry for new versions and shows a notification.
 * Caches the check result to avoid checking on every run (once per day).
 * This is notification-only — actual updates are done via `claudish update`.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const isWindows = platform() === "win32";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/claudish/latest";

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ANSI color codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

interface UpdateCache {
  lastCheck: number;
  latestVersion: string | null;
}

/**
 * Get cache file path
 * Uses platform-appropriate cache directory:
 * - Windows: %LOCALAPPDATA%\claudish or %USERPROFILE%\AppData\Local\claudish
 * - Unix/macOS: ~/.cache/claudish
 */
function getCacheFilePath(): string {
  let cacheDir: string;

  if (isWindows) {
    // Windows: Use LOCALAPPDATA or fall back to AppData\Local
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    cacheDir = join(localAppData, "claudish");
  } else {
    // Unix/macOS: Use ~/.cache/claudish
    cacheDir = join(homedir(), ".cache", "claudish");
  }

  try {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    return join(cacheDir, "update-check.json");
  } catch {
    // Fall back to temp directory if home cache fails
    return join(tmpdir(), "claudish-update-check.json");
  }
}

/**
 * Read cached update check result
 */
function readCache(): UpdateCache | null {
  try {
    const cachePath = getCacheFilePath();
    if (!existsSync(cachePath)) {
      return null;
    }
    const data = JSON.parse(readFileSync(cachePath, "utf-8"));
    return data as UpdateCache;
  } catch {
    return null;
  }
}

/**
 * Write update check result to cache
 */
function writeCache(latestVersion: string | null): void {
  try {
    const cachePath = getCacheFilePath();
    const data: UpdateCache = {
      lastCheck: Date.now(),
      latestVersion,
    };
    writeFileSync(cachePath, JSON.stringify(data), "utf-8");
  } catch {
    // Silently fail - caching is optional
  }
}

/**
 * Check if cache is still valid (less than 24 hours old)
 */
function isCacheValid(cache: UpdateCache): boolean {
  const age = Date.now() - cache.lastCheck;
  return age < CACHE_MAX_AGE_MS;
}

/**
 * Clear the update cache (called after successful update)
 */
export function clearCache(): void {
  try {
    const cachePath = getCacheFilePath();
    if (existsSync(cachePath)) {
      unlinkSync(cachePath);
    }
  } catch {
    // Silently fail
  }
}

/**
 * Semantic version comparison
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.replace(/^v/, "").split(".").map(Number);
  const parts2 = v2.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

export interface FetchVersionOptions {
  /** Per-attempt timeout. Default 5s (the background check must not stall startup). */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 0. */
  retries?: number;
}

/**
 * Fetch latest version from npm registry, throwing a descriptive error on failure.
 *
 * Callers that want to report *why* the check failed use this; `fetchLatestVersion`
 * wraps it for the fire-and-forget startup notification. Registry latency here is
 * spiky (sub-200ms when warm, multiple seconds on a cold DNS/TLS handshake), so an
 * aggressive timeout with no retry turns a slow network into a hard failure.
 */
export async function fetchLatestVersionOrThrow(options: FetchVersionOptions = {}): Promise<string> {
  const { timeoutMs = 5000, retries = 0 } = options;
  let lastError: Error = new Error("unknown error");

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(NPM_REGISTRY_URL, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`npm registry returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as { version?: string };
      if (!data.version) {
        throw new Error("npm registry response contained no version field");
      }
      return data.version;
    } catch (error) {
      // AbortError means our own timeout fired — say so, rather than blaming the network.
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? new Error(`request timed out after ${timeoutMs}ms`)
          : error instanceof Error
            ? error
            : new Error(String(error));
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

/**
 * Fetch latest version from npm registry. Returns null on any failure.
 */
export async function fetchLatestVersion(options: FetchVersionOptions = {}): Promise<string | null> {
  try {
    return await fetchLatestVersionOrThrow(options);
  } catch {
    // Network error, timeout, or parsing error - silently fail
    return null;
  }
}

/**
 * Check for updates and show notification
 *
 * Uses a cache to avoid checking npm on every run (once per 24 hours).
 * This is notification-only — does not auto-update or prompt.
 *
 * @param currentVersion - Current installed version
 * @param options - Configuration options
 */
export async function checkForUpdates(
  currentVersion: string,
  options: {
    quiet?: boolean;
  } = {}
): Promise<void> {
  const { quiet = false } = options;

  let latestVersion: string | null = null;

  // Check cache first
  const cache = readCache();
  if (cache && isCacheValid(cache)) {
    // Use cached version
    latestVersion = cache.latestVersion;
  } else {
    // Cache is stale or doesn't exist - fetch from npm
    latestVersion = await fetchLatestVersion();
    // Update cache (even if null - to avoid repeated failed requests)
    writeCache(latestVersion);
  }

  if (!latestVersion) {
    // Couldn't fetch - silently continue
    return;
  }

  // Compare versions
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    // Already up to date
    return;
  }

  // New version available — show single-line notification
  if (!quiet) {
    console.error("");
    console.error(
      `  ${CYAN}\u250c${RESET} ${BOLD}Update available:${RESET} ${currentVersion} ${DIM}\u2192${RESET} ${GREEN}${latestVersion}${RESET}   ${DIM}Run:${RESET} ${BOLD}${CYAN}claudish update${RESET}`
    );
    console.error("");
  }
}
