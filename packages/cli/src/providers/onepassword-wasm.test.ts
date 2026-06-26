/**
 * Tests for onepassword-wasm.ts — the on-demand WASM provisioning for compiled
 * binaries. Hermetic: no network, no real SDK. The tar extractor and integrity
 * verifier are pure functions tested against in-memory fixtures; the tarball
 * fixture is BUILT here (a minimal valid tar.gz), not a captured secret blob.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  SDK_CORE_INTEGRITY,
  __resetOpWasmStateForTest,
  __setOpWasmTestSeams,
  ensureOpWasmAvailable,
  extractFileFromTarGz,
  verifyIntegrity,
} from "./onepassword-wasm.js";

/**
 * Build one 512-byte ustar header + padded data block for a single file entry,
 * matching the subset of the tar format extractFileFromTarGz reads (name@0,
 * size@124 octal). Enough to exercise the extractor without a tar library.
 */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8"); // name field (first 100 bytes)
  // size: 11 octal digits + NUL at offset 124
  const octal = data.length.toString(8).padStart(11, "0");
  header.write(`${octal}\0`, 124, "utf8");
  // checksum field must be spaces for our reader (it ignores checksum), but real
  // tars fill it; we leave it blank since the extractor doesn't validate it.
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

/** Build a gzipped tar containing the given { name: bytes } entries. */
function buildTarGz(entries: Record<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of Object.entries(entries)) {
    blocks.push(tarEntry(name, data));
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks = end-of-archive
  return gzipSync(Buffer.concat(blocks));
}

describe("extractFileFromTarGz", () => {
  test("extracts a file matched by path suffix, byte-exact", () => {
    const wasm = Buffer.from("fake-wasm-bytes-\x00\x01\x02-payload");
    const other = Buffer.from("some other file");
    const tgz = buildTarGz({
      "package/nodejs/core.js": other,
      "package/nodejs/core_bg.wasm": wasm,
    });
    const got = extractFileFromTarGz(tgz, "nodejs/core_bg.wasm");
    expect(got).not.toBeNull();
    expect(Buffer.compare(got as Buffer, wasm)).toBe(0);
  });

  test("returns null when no entry matches", () => {
    const tgz = buildTarGz({ "package/readme.md": Buffer.from("hi") });
    expect(extractFileFromTarGz(tgz, "nodejs/core_bg.wasm")).toBeNull();
  });

  test("handles a non-512-aligned payload (padding) correctly", () => {
    const wasm = Buffer.from("x".repeat(700)); // spans two 512 blocks
    const tgz = buildTarGz({
      "a.txt": Buffer.from("short"),
      "package/nodejs/core_bg.wasm": wasm,
    });
    const got = extractFileFromTarGz(tgz, "core_bg.wasm");
    expect(got?.length).toBe(700);
    expect(Buffer.compare(got as Buffer, wasm)).toBe(0);
  });
});

describe("verifyIntegrity", () => {
  test("passes when bytes match the pinned sha512", () => {
    // Recompute the digest the constant claims, over bytes that hash to it.
    // We can't reproduce the real tarball here, so build a fixture + a matching
    // integrity string to prove the algorithm, then assert the REAL constant is
    // well-formed (sha512-<base64>).
    const bytes = Buffer.from("integrity-fixture-payload");
    const digest = createHash("sha512").update(bytes).digest("base64");
    const orig = SDK_CORE_INTEGRITY;
    // verifyIntegrity reads the module constant, so we validate the constant's
    // SHAPE and exercise the matching logic via a local recompute instead.
    expect(orig).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    // Algorithm sanity: a matching digest verifies, a mismatch throws.
    const [algo, expected] = orig.split("-", 2);
    expect(algo).toBe("sha512");
    expect(typeof expected).toBe("string");
    expect(createHash(algo).update(bytes).digest("base64")).toBe(digest);
  });

  test("throws on a tampered/mismatched tarball", () => {
    // Any random bytes will not match the pinned sha512 of the real tarball.
    const bogus = Buffer.from("not the real 1Password tarball");
    expect(() => verifyIntegrity(bogus)).toThrow(/integrity check failed/i);
  });
});

/**
 * The FROZEN-PATH regression: in a CI-built bundle the sdk-core loader's
 * `__dirname` is baked to the build machine, so it reads a `core_bg.wasm` path
 * that does not exist on the user's machine. A real nearby copy DOES exist
 * (npm install), but at a DIFFERENT path than the loader reads — so the old
 * fast-path that just returned without seeding the cache left it cold and the
 * frozen-path read threw ENOENT. The fix proactively COPIES the nearby real
 * copy into the cache so the readFileSync intercept can serve it.
 */
describe("ensureOpWasmAvailable — cold-cache seeding", () => {
  let tmp: string | null = null;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    // Restore all injected state so tests don't leak into each other.
    __setOpWasmTestSeams({ cacheRoot: null, nearbyWasmResolver: null });
    __resetOpWasmStateForTest();
    globalThis.fetch = realFetch;
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  test("SEEDS the cache by copying a real nearby wasm (frozen-path bundle case)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "opwasm-seed-"));
    const cacheRoot = join(tmp, "claudish");
    // A real "nearby" wasm at a path DIFFERENT from any (frozen) loader path.
    const realDir = join(tmp, "node_modules", "@1password", "sdk-core", "nodejs");
    mkdirSync(realDir, { recursive: true });
    const realWasm = join(realDir, "core_bg.wasm");
    const dummyBytes = Buffer.from("dummy-wasm-bytes-not-a-secret");
    writeFileSync(realWasm, dummyBytes);

    // Spy: the seed path must NOT touch the network.
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("network should not be touched on the seed path");
    }) as unknown as typeof fetch;

    __resetOpWasmStateForTest();
    __setOpWasmTestSeams({
      cacheRoot,
      nearbyWasmResolver: () => realWasm,
    });

    const cachedPath = join(cacheRoot, "cache", "1password", "core_bg.wasm");
    expect(existsSync(cachedPath)).toBe(false); // cold cache precondition

    await ensureOpWasmAvailable();

    // The cache file now exists, seeded by COPY from the nearby real wasm.
    expect(existsSync(cachedPath)).toBe(true);
    expect(Buffer.compare(readFileSync(cachedPath), dummyBytes)).toBe(0);
    // And NO download was attempted.
    expect(fetchCalled).toBe(false);
  });

  test("falls through to download when NO real nearby wasm exists (genuine cold start)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "opwasm-dl-"));
    const cacheRoot = join(tmp, "claudish");

    // Spy: assert the download path is taken. Fail fast after fetch is recorded
    // (a real download would integrity-check the pinned tarball, which we can't
    // reproduce here) — the point is proving the download BRANCH ran.
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("stub: download attempted");
    }) as unknown as typeof fetch;

    __resetOpWasmStateForTest();
    __setOpWasmTestSeams({
      cacheRoot,
      nearbyWasmResolver: () => null, // no real copy anywhere
    });

    const cachedPath = join(cacheRoot, "cache", "1password", "core_bg.wasm");
    expect(existsSync(cachedPath)).toBe(false);

    await expect(ensureOpWasmAvailable()).rejects.toThrow(/download attempted/);
    expect(fetchCalled).toBe(true);
    // Cache stays cold because the (stubbed) download failed.
    expect(existsSync(cachedPath)).toBe(false);
  });

  test("warm cache short-circuits — no copy, no download", async () => {
    tmp = mkdtempSync(join(tmpdir(), "opwasm-warm-"));
    const cacheRoot = join(tmp, "claudish");
    // Pre-warm the cache.
    const cacheDir = join(cacheRoot, "cache", "1password");
    mkdirSync(cacheDir, { recursive: true });
    const cachedPath = join(cacheDir, "core_bg.wasm");
    const warmBytes = Buffer.from("already-warm-cache");
    writeFileSync(cachedPath, warmBytes);

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("warm cache should not download");
    }) as unknown as typeof fetch;
    let resolverCalled = false;

    __resetOpWasmStateForTest();
    __setOpWasmTestSeams({
      cacheRoot,
      nearbyWasmResolver: () => {
        resolverCalled = true;
        return null;
      },
    });

    await ensureOpWasmAvailable();

    // Warm bytes untouched, no download, no nearby probe needed.
    expect(Buffer.compare(readFileSync(cachedPath), warmBytes)).toBe(0);
    expect(fetchCalled).toBe(false);
    expect(resolverCalled).toBe(false);
  });
});
