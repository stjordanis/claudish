/**
 * On-demand 1Password WASM provisioning for COMPILED claudish binaries.
 *
 * The `@1password/sdk` depends on `@1password/sdk-core`, whose `nodejs/core.js`
 * loads its WebAssembly with `readFileSync(join(__dirname, 'core_bg.wasm'))`.
 * `bun build --compile` bundles that loader but rewrites `__dirname` to the
 * BUILD MACHINE's absolute path (e.g. `/home/runner/work/claudish/...`). At
 * runtime on a user's machine that path does not exist, so the SDK import dies
 * with `ENOENT: ... core_bg.wasm`. npm-installed users are unaffected — their
 * real `node_modules` copy is right where the loader expects it.
 *
 * Fix: BEFORE the SDK is dynamically imported, install a one-time intercept on
 * `fs.readFileSync` that catches any read of `core_bg.wasm` and serves it from
 * a local cache (`~/.claudish/cache/1password/core_bg.wasm`). If the cache is
 * cold AND the loader's own path is missing (the compiled-binary case), we
 * download the exact pinned `@1password/sdk-core` tarball from the OFFICIAL npm
 * registry, verify its SHA-512 against the pinned integrity, extract the single
 * `core_bg.wasm`, and populate the cache. ~10MB, fetched at most once per
 * machine; a non-1Password user never reaches this code at all.
 *
 * Dependency-light by contract (this module is reachable from the
 * dependency-light onepassword.ts): node built-ins ONLY (fs, os, path, zlib,
 * crypto, module, https via fetch). No new package dependency.
 *
 * PIN SYNC: SDK_CORE_VERSION / SDK_CORE_INTEGRITY must match the
 * `@1password/sdk-core` that `@1password/sdk` (in package.json) resolves to.
 * On an SDK bump, refresh both — `npm view @1password/sdk-core@<v> dist.integrity`.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * The `@1password/sdk-core` version + npm integrity that `@1password/sdk`
 * resolves to. KEEP IN SYNC with package.json's `@1password/sdk` pin.
 */
export const SDK_CORE_VERSION = "0.4.1-beta.1";
export const SDK_CORE_INTEGRITY =
  "sha512-/otbg1JVhsEn6oUIeReoT9TmFr8J7KBwr9UuRVfJFwwGG3bHPF8ewT+LhRimQeJtypqQ69ZVuOYkxknD4iQHxw==";

/** The single filename the SDK loader reads — our stable redirect hook. */
const WASM_FILENAME = "core_bg.wasm";
/** Path of the WASM inside the npm tarball (tarballs prefix entries with `package/`). */
const WASM_TARBALL_ENTRY = "nodejs/core_bg.wasm";

/** Official npm registry tarball URL for the pinned sdk-core. */
function tarballUrl(): string {
  return `https://registry.npmjs.org/@1password/sdk-core/-/sdk-core-${SDK_CORE_VERSION}.tgz`;
}

/**
 * Test seam: override the cache root (the dir that holds `1password/core_bg.wasm`)
 * and the "real nearby wasm" resolver. Both default to the production behavior
 * (homedir-based cache, createRequire-based package resolution). Tests inject
 * temp paths so the copy/seed control flow can be exercised hermetically without
 * touching the user's real `~/.claudish` or `node_modules`.
 */
let cacheRootOverride: string | null = null;
let nearbyWasmResolverOverride: (() => string | null) | null = null;

/** ~/.claudish/cache/1password/core_bg.wasm — the redirect target. */
function cacheWasmPath(): string {
  const root = cacheRootOverride ?? join(homedir(), ".claudish");
  return join(root, "cache", "1password", WASM_FILENAME);
}

/** Module-scoped guards so the intercept + provisioning each run at most once. */
let interceptInstalled = false;
let ensured: Promise<void> | null = null;
/**
 * Sticky "checked this run, all good" flag. Set ONCE the WASM is confirmed
 * loadable (cache warm, real copy found, or download+verify succeeded). When
 * true, ensureOpWasmAvailable() returns synchronously without re-probing the
 * filesystem or re-awaiting — every subsequent op:// resolution in the same run
 * is a free no-op. Never set on failure (so a retry can re-run provisioning).
 */
let wasmReady = false;

/**
 * Verify a downloaded tarball's bytes against the pinned `sha512-<base64>`
 * Subresource-Integrity string. Throws on mismatch (never caches a bad file).
 */
export function verifyIntegrity(bytes: Buffer): void {
  const [algo, expected] = SDK_CORE_INTEGRITY.split("-", 2);
  const actual = createHash(algo).update(bytes).digest("base64");
  if (actual !== expected) {
    throw new Error(
      `1Password runtime integrity check failed (${algo}): expected ${expected}, got ${actual}`
    );
  }
}

/**
 * Extract a single file (matched by path suffix) from a gzipped tar buffer
 * using node built-ins only — gunzip, then walk 512-byte tar headers. Returns
 * the file bytes, or null if not found.
 */
export function extractFileFromTarGz(tgz: Buffer, entrySuffix: string): Buffer | null {
  const tar = gunzipSync(tgz);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break; // end-of-archive (zero block)
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const dataStart = off + 512;
    if (name.endsWith(entrySuffix)) {
      return tar.subarray(dataStart, dataStart + size);
    }
    off = dataStart + Math.ceil(size / 512) * 512; // header + padded data
  }
  return null;
}

/**
 * Install (once) the `fs.readFileSync` intercept that redirects any read whose
 * path ends in `core_bg.wasm` to our cache file. We patch via `createRequire`'s
 * CJS `fs` module because the ESM `node:fs` namespace export is read-only under
 * Bun. The SDK loader is CJS (`require('fs')`), so it sees the patched fn.
 */
function installReadFileSyncIntercept(): void {
  if (interceptInstalled) return;
  const require = createRequire(import.meta.url);
  const fs = require("node:fs") as typeof import("node:fs");
  const original = fs.readFileSync;
  // @ts-expect-error — replacing the overloaded builtin with a delegating wrapper.
  fs.readFileSync = (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.endsWith(WASM_FILENAME)) {
      const cached = cacheWasmPath();
      if (existsSync(cached)) {
        return (original as (p: string) => Buffer)(cached);
      }
      // Cache cold but the loader's OWN path exists (npm-install case): seed the
      // cache from it so future runs are self-contained, then serve it.
      if (existsSync(path)) {
        try {
          mkdirSync(dirname(cached), { recursive: true });
          copyFileSync(path, cached);
        } catch {
          // Non-fatal: fall through to reading the original path directly.
        }
      }
    }
    return (original as (...a: unknown[]) => Buffer)(path, ...rest);
  };
  interceptInstalled = true;
}

/**
 * Download + verify + cache the WASM. Called only when the cache is cold AND
 * the loader's own path is missing (compiled-binary case). Emits a single
 * stderr line so the one-time ~10MB fetch isn't a silent stall.
 */
async function downloadAndCacheWasm(): Promise<void> {
  const cached = cacheWasmPath();
  process.stderr.write("[claudish] fetching 1Password runtime (~10MB, one time)…\n");
  const res = await fetch(tarballUrl());
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${tarballUrl()}`);
  }
  const tgz = Buffer.from(await res.arrayBuffer());
  verifyIntegrity(tgz);
  const wasm = extractFileFromTarGz(tgz, WASM_TARBALL_ENTRY);
  if (!wasm) {
    throw new Error(`1Password runtime archive did not contain ${WASM_TARBALL_ENTRY}`);
  }
  mkdirSync(dirname(cached), { recursive: true });
  // Write atomically-ish: temp then rename, so a partial write can't poison cache.
  const tmp = `${cached}.tmp`;
  writeFileSync(tmp, wasm);
  // rename is in node:fs (sync) — pull from the same CJS module to avoid an import.
  createRequire(import.meta.url)("node:fs").renameSync(tmp, cached);
  process.stderr.write("[claudish] 1Password runtime cached.\n");
}

/**
 * Ensure the 1Password SDK's `core_bg.wasm` is loadable, then return. Idempotent
 * and memoized (concurrent callers share one provisioning). Call IMMEDIATELY
 * before `await import("@1password/sdk")`.
 *
 * Fast path (npm install, or warm cache): installs the read intercept and
 * returns without any network access — the file already exists on disk.
 * Slow path (compiled binary, cold cache): downloads + verifies + caches once.
 *
 * Once provisioning succeeds, the sticky `wasmReady` flag makes every later call
 * an instant no-op (no filesystem re-probe, no re-await) for the rest of the run.
 */
export function ensureOpWasmAvailable(): Promise<void> {
  if (wasmReady) return Promise.resolve(); // already checked this run, all good
  if (ensured) return ensured;
  ensured = (async () => {
    installReadFileSyncIntercept();
    // Warm cache → nothing to do (intercept already serves it).
    if (existsSync(cacheWasmPath())) return;
    // Cold cache. PROACTIVELY seed the cache from a real `core_bg.wasm` on disk
    // near this module (the npm-install layout). We CANNOT rely on the intercept
    // to seed it: in a compiled/bundled binary the loader's `__dirname` is FROZEN
    // to the build-machine path, so the path it actually reads is a dead
    // `/home/runner/...` that no longer exists — the intercept's
    // `if (existsSync(loaderPath))` branch never fires and the cache stays cold.
    // By copying the real nearby copy into the cache NOW, the intercept's
    // `if (existsSync(cached))` branch serves it regardless of the frozen path.
    if (seedCacheFromNearbyWasm()) return; // real copy found → seeded into cache
    // No real copy anywhere (genuine compiled-binary cold start): download it.
    await downloadAndCacheWasm();
  })();
  // Mark ready on success (sticky) / clear the memo on failure so a later attempt
  // can retry (e.g. a transient network blip during the one-time download).
  ensured.then(
    () => {
      wasmReady = true;
    },
    () => {
      ensured = null;
    }
  );
  return ensured;
}

/**
 * Resolve a real `core_bg.wasm` already on disk near this module (the npm-install
 * layout: .../node_modules/@1password/sdk-core/nodejs/...). Returns its absolute
 * path, or null if none exists (e.g. a compiled binary with no node_modules tree).
 */
function resolveNearbyWasmPath(): string | null {
  if (nearbyWasmResolverOverride) return nearbyWasmResolverOverride();
  try {
    const require = createRequire(import.meta.url);
    // Resolve the sdk-core package's loader; its sibling is core_bg.wasm.
    const coreJs = require.resolve("@1password/sdk-core/nodejs/core.js");
    const wasm = join(dirname(coreJs), WASM_FILENAME);
    return existsSync(wasm) ? wasm : null;
  } catch {
    return null;
  }
}

/**
 * Proactively seed the cache from a real `core_bg.wasm` found near this module.
 *
 * This is the CRUX of the compiled-binary fix. A real npm-install copy exists at
 * a path the bundled loader will NOT read (the loader's `__dirname` is frozen to
 * the build machine), so we must copy the real copy into our cache OURSELVES —
 * the intercept then serves the cache via its `existsSync(cached)` branch. We can
 * no longer bet on the intercept's `existsSync(loaderPath)` branch firing, since
 * `loaderPath` is the dead frozen `/home/runner/...` path on the user's machine.
 *
 * Returns true if a real copy was found AND successfully copied into the cache.
 * Returns false when no real copy exists (genuine compiled cold start → caller
 * falls through to download), or if the copy failed (caller downloads as a
 * fallback rather than leaving the cache empty).
 */
function seedCacheFromNearbyWasm(): boolean {
  const real = resolveNearbyWasmPath();
  if (!real) return false; // no real copy → caller downloads
  try {
    const cached = cacheWasmPath();
    mkdirSync(dirname(cached), { recursive: true });
    copyFileSync(real, cached);
    return true;
  } catch {
    // Copy failed (e.g. unwritable cache dir): let the caller download instead
    // of returning true on an empty cache.
    return false;
  }
}

/** Test seam: reset memoized state so a test can re-exercise provisioning. */
export function __resetOpWasmStateForTest(): void {
  ensured = null;
  interceptInstalled = false;
  wasmReady = false;
}

/**
 * Test seam: point the cache root and "nearby wasm" resolver at injected paths
 * so the seed/copy control flow runs hermetically (no real `~/.claudish`, no
 * `node_modules` probe, no network). Pass `null` for either to restore the
 * production default. Combine with `__resetOpWasmStateForTest()`.
 */
export function __setOpWasmTestSeams(opts: {
  cacheRoot?: string | null;
  nearbyWasmResolver?: (() => string | null) | null;
}): void {
  if ("cacheRoot" in opts) cacheRootOverride = opts.cacheRoot ?? null;
  if ("nearbyWasmResolver" in opts)
    nearbyWasmResolverOverride = opts.nearbyWasmResolver ?? null;
}
